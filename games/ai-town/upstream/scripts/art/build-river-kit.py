"""Build the reusable river-town set without touching an interactive Blender scene.

Run: blender --background --factory-startup --python scripts/art/build-river-kit.py
     -- --atlas frontend/town-2d/src/assets/river-material-atlas.png
The atlas is original imagegen artwork. All geometry is generated here; the five
grounded root groups are exported at the origin for independent game instancing.
"""

import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
args = argparse.ArgumentParser()
args.add_argument("--atlas", type=Path, default=ROOT / "frontend/town-2d/src/assets/river-material-atlas.png")
args.add_argument("--render", action="store_true")
opts = args.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
random.seed(7141)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

image = bpy.data.images.load(str(opts.atlas.resolve()))
image.pack()
QUADS = {"stone": (0.015, 0.515), "roof": (0.515, 0.515), "wood": (0.015, 0.015), "leaf": (0.515, 0.015)}
materials = {}


def material(name, color, roughness=0.9, metal=0, atlas=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color[:3], color[3] if len(color) > 3 else 1)
    mat.use_nodes = True
    p = mat.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = mat.diffuse_color
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Metallic"].default_value = metal
    if atlas:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Closest"
        mat.node_tree.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    if mat.diffuse_color[3] < 1:
        p.inputs["Alpha"].default_value = mat.diffuse_color[3]
        mat.surface_render_method = "DITHERED"
    materials[name] = mat
    return mat


for key in QUADS:
    material(key, (1, 1, 1), atlas=True)
material("water", (0.045, 0.29, 0.31), 0.22, 0.18)
material("water_glint", (0.48, 0.77, 0.67), 0.3, 0.1)
material("bronze", (0.22, 0.21, 0.09), 0.62, 0.7)
material("glass", (0.21, 0.40, 0.40, 0.22), 0.3)
material("soil", (0.085, 0.059, 0.026))
material("clay", (0.40, 0.16, 0.065))
for i, col in enumerate([(0.18, 0.26, 0.045), (0.31, 0.36, 0.065), (0.43, 0.43, 0.09), (0.12, 0.22, 0.055)]):
    material("leaf%d" % i, col)
for key, col in {"ivory": (0.87, 0.80, 0.54), "pink": (0.67, 0.22, 0.32), "lavender": (0.36, 0.26, 0.48), "gold": (0.86, 0.55, 0.07)}.items():
    material(key, col)

groups = []
current = None


def group(name):
    global current
    current = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(current)
    groups.append(current)
    return current


def finish(obj, mat, smooth=False):
    obj.parent = current
    obj.data.materials.append(materials[mat])
    if smooth:
        for face in obj.data.polygons:
            face.use_smooth = True
    if mat in QUADS:
        # Blender primitives already carry a UVMap; remove it so glTF and Cycles
        # both sample the authored atlas coordinates rather than a full-sheet UV.
        while obj.data.uv_layers:
            obj.data.uv_layers.remove(obj.data.uv_layers[0])
        uv = obj.data.uv_layers.new(name="Atlas")
        lower = QUADS[mat]
        bounds_min=[min(v.co[i] for v in obj.data.vertices) for i in range(3)]
        bounds_span=[max(max(v.co[i] for v in obj.data.vertices)-bounds_min[i], .001) for i in range(3)]
        # Per-face planar UVs keep narrow stone/timber faces inside one atlas tile.
        for poly in obj.data.polygons:
            axis = max(range(3), key=lambda i: abs(poly.normal[i]))
            plane = [i for i in range(3) if i != axis]
            coords = [obj.data.vertices[obj.data.loops[j].vertex_index].co for j in poly.loop_indices]
            mins = [min(c[a] for c in coords) for a in plane]
            spans = [max(max(c[a] for c in coords) - mins[i], 0.001) for i, a in enumerate(plane)]
            if mat == "leaf":
                mins=[bounds_min[a] for a in plane]
                spans=[bounds_span[a] for a in plane]
            tile_scale=(.10,.12) if mat == "stone" else (.06,.44) if mat == "wood" else (.47,.47)
            for j, co in zip(poly.loop_indices, coords):
                uv.data[j].uv = [lower[i] + tile_scale[i] * (co[a] - mins[i]) / spans[i] for i, a in enumerate(plane)]
    return obj


def mesh(name, verts, faces, mat, smooth=False):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    return finish(obj, mat, smooth)


def cube(name, center, scale, mat="wood", angle=0, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler.z = angle
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("Worn edges", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return finish(obj, mat)


def beam(name, a, b, radius, mat="wood", end=None, segments=7):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=segments, radius1=radius, radius2=end if end is not None else radius,
                                    depth=d.length, location=(a+b)/2)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return finish(obj, mat, True)


def disc(name, radius, z, thickness, mat="stone", count=24, xy=(0, 0), upper=None):
    return beam(name, (*xy, z), (*xy, z+thickness), radius, mat, upper, count)


def lobe(name, p, size, mat="leaf", subdivisions=2, jitter=0.14):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1, location=p)
    obj = bpy.context.object
    obj.name = name
    for v in obj.data.vertices:
        f = random.uniform(1-jitter, 1+jitter)
        v.co = Vector([v.co[i]*size[i]*f for i in range(3)])
    return finish(obj, mat, True)


def ring_stones(name, outer, inner, z, height, n=20):
    for i in range(n):
        a = math.tau * (i+0.018)/n
        b = math.tau * (i+0.982)/n
        v = [(r*math.cos(t), r*math.sin(t), zz) for zz in [z, z+height] for r,t in [(inner,a),(outer,a),(outer,b),(inner,b)]]
        mesh(name+str(i), v, [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], "stone")


def leaf_spray(p, size=0.15, count=7):
    for i in range(count):
        a = math.tau*i/count + random.random()*0.35
        x,y,z = p
        length = size*random.uniform(0.8,1.3)
        tip = (x+math.cos(a)*length,y+math.sin(a)*length,z+random.uniform(-0.025,0.075))
        side = (-math.sin(a)*length*.28, math.cos(a)*length*.28)
        mid = ((x+tip[0])/2,(y+tip[1])/2,z+length*.22)
        mesh("Individual leaves", [p,(mid[0]+side[0],mid[1]+side[1],mid[2]),tip,(mid[0]-side[0],mid[1]-side[1],mid[2])], [(0,1,2),(0,2,3)], "leaf%d" % random.randrange(4))


def flowers(center, spread=0.25, n=9):
    for i in range(n):
        x = center[0]+random.uniform(-spread,spread)
        y = center[1]+random.uniform(-spread*.65,spread*.65)
        z = center[2]+random.uniform(.1,.32)
        beam("Flower stem",(x,y,center[2]),(x+.015,y,z),.012,"leaf3",segments=4)
        leaf_spray((x,y,z-.09), .085, 3)
        petalmat = ["ivory","pink","lavender"][i%3]
        for j in range(5):
            a = math.tau*j/5
            lobe("Petal", (x+.046*math.cos(a),y+.046*math.sin(a),z), (.052,.052,.03), petalmat, 1, .04)
        lobe("Pollen",(x,y,z+.015),(.025,.025,.027),"gold",1,.02)


group("RiverFountain")
disc("Octagonal plinth",1.23,0,.09,count=8)
ring_stones("Basin lower masonry",1.12,.88,.09,.17,18)
ring_stones("Basin upper masonry",1.15,.86,.265,.15,18)
ring_stones("Hand worn rim",1.19,.83,.415,.075,24)
disc("Deep still water",.88,.30,.025,"water")
disc("Central foot",.29,.32,.12)
disc("Carved pedestal",.18,.44,.45,upper=.12)
disc("Pedestal collar",.25,.88,.08)
disc("Upper bowl base",.29,.96,.10,upper=.5)
ring_stones("Upper scallop bowl",.52,.42,1.05,.09,16)
disc("Upper water",.42,1.085,.012,"water")
disc("Bronze stem",.075,1.09,.20,"bronze",12,upper=.035)
lobe("Bronze seed finial",(0,0,1.36),(.075,.075,.13),"bronze",2,.04)
for i in range(6):
    a=math.tau*i/6
    xy=(.49*math.cos(a),.49*math.sin(a))
    beam("Falling water",(*xy,1.065),(*xy,.36),.014,"water_glint",end=.022,segments=5)
    for j in range(3):
        a2=a+j*2
        lobe("Surface ripple",(xy[0]+.04*math.cos(a2),xy[1]+.04*math.sin(a2),.33),(.06,.018,.005),"water_glint",1,.03)


group("RiverGardenPavilion")
cube("Masonry foundation",(0,0,.12),(4.0,3.0,.24),"stone",bevel=.04)
for y in [-1.34,1.34]:
    for x in [-1.8,-.6,.6,1.8]:
        cube("Stone pier",(x,y,.42),(.35,.34,.60),"stone",bevel=.025)
        cube("Structural upright",(x,y,1.50),(.13,.13,2.0))
        cube("Cap tenon",(x,y,2.52),(.22,.22,.1))
        if x < 1.7:
            cube("Sill",(x+.6,y,.70),(1.2,.12,.12))
            cube("Lintel",(x+.6,y,2.47),(1.2,.14,.14))
            for z in [1.24,1.83]:
                cube("Glazing bar",(x+.6,y,z),(1.2,.045,.045),"bronze")
            cube("Glazing upright",(x+.6,y,1.58),(.04,.05,1.75),"bronze")
            cube("Old greenhouse glazing",(x+.6,y,1.58),(1.13,.012,1.7),"glass")
for x in [-1.8,1.8]:
    beam("Gable rafter",(x,-1.48,2.45),(x,0,3.24),.065,segments=4)
    beam("Gable rafter",(x,0,3.24),(x,1.48,2.45),.065,segments=4)
    cube("Gable tie",(x,0,2.47),(.13,2.8,.13))
    beam("Gable king post",(x,0,2.47),(x,0,3.24),.05,"wood",segments=4)
    for y in [-1.05,-.63,.63,1.05]:
        cube("End wall stile",(x,y,1.58),(.06,.06,1.70))
    if x > 0:
        cube("End glazing",(x,0,1.58),(.014,2.55,1.70),"glass")
    else:
        for y in [-.94,.94]:
            cube("Door side glass",(x,y,1.58),(.014,.65,1.70),"glass")
        cube("Open doorway lintel",(x,0,2.29),(.18,1.18,.12))
cube("Ridge beam",(0,0,3.24),(3.95,.13,.13))
for x in [-1.8,-1.2,-.6,0,.6,1.2,1.8]:
    for side in [-1,1]:
        beam("Roof frame",(x,0,3.24),(x,side*1.48,2.45),.035,"bronze",segments=4)
for side in [-1,1]:
    mesh("Roof glazing",[(-1.8,0,3.22),(1.8,0,3.22),(1.8,side*1.44,2.46),(-1.8,side*1.44,2.46)],[(0,1,2,3)],"glass")
    cube("Eave rail",(0,side*1.47,2.46),(3.98,.11,.11))
    for x in [-1.8,1.8]:
        beam("Corner brace",(x,side*1.34,2.02),(x*.76,side*1.34,2.46),.055,segments=4)
for x in [-1.2,0,1.2]:
    for y in [-.94,.94]:
        cube("Growing bench",(x,y,.75),(1.0,.55,.10))
        for yy in [-.17,.17]:
            cube("Bench leg",(x,y+yy,.47),(.07,.07,.52))
        for offset in [-.26,.12]:
            disc("Terracotta seed pot",.16,.8,.24,"clay",10,(x+offset,y),.21)
            disc("Potting soil",.18,1.03,.015,"soil",10,(x+offset,y))
            flowers((x+offset,y,1.03),.12,4)
for i in range(15):
    p=(-1.7+i*.24,1.45+random.uniform(-.05,.05),2.48+random.uniform(0,.22))
    leaf_spray(p,.19,6)
    if i%3==0:
        lobe("Climbing vine",p,(.24,.17,.16),"leaf",1,.2)


group("RiverFlowerBoxes")
for x,y,w in [(-.64,0,1.05),(.52,.2,.80),(.12,-.52,.64)]:
    cube("Box soil",(x,y,.29),(w,.43,.16),"soil")
    for side in [-1,1]:
        cube("Flower box long board",(x,y+side*.24,.24),(w+.10,.06,.34),"wood",bevel=.012)
        cube("Flower box end board",(x+side*(w/2+.02),y,.24),(.06,.50,.34),"wood",bevel=.012)
        for xx in [-w*.34,w*.34]:
            cube("Iron strap",(x+xx,y+side*.277,.24),(.045,.015,.35),"bronze")
    flowers((x,y,.37),w*.42,12)
    for i in range(8):
        leaf_spray((x+random.uniform(-w*.46,w*.46),y+random.uniform(-.19,.19),.40),.14,5)


group("RiverOak")
# A bent ring trunk and exposed roots retain a readable silhouette at low angles.
trunk_centers=[(0,0,0),(.05,-.02,.42),(-.08,.01,1.2),(.02,.04,2.0),(.24,.04,2.8),(.25,.1,3.7),(.38,.12,4.4)]
radii=[.36,.28,.24,.20,.15,.09,.035]
verts=[]
for k,p in enumerate(trunk_centers):
    for i in range(9):
        a=math.tau*i/9
        radius=radii[k]*(1+.1*math.sin(i*3.1+k))
        verts.append((p[0]+radius*math.cos(a),p[1]+radius*math.sin(a),p[2]))
faces=[tuple(range(8,-1,-1)),tuple(range(54,63))]
for k in range(6):
    for i in range(9):
        faces.append((k*9+i,k*9+(i+1)%9,(k+1)*9+(i+1)%9,(k+1)*9+i))
mesh("Twisting ancient trunk",verts,faces,"wood",True)
for i in range(8):
    a=math.tau*i/8
    beam("Surface roots",(0,0,.25),(.78*math.cos(a),.78*math.sin(a),.045),.14,"wood",.035,7)
    beam("Root finger",(.67*math.cos(a),.67*math.sin(a),.05),(1.05*math.cos(a+.10),1.05*math.sin(a+.10),.025),.045,"wood",.008,5)
crown=[]
for i in range(11):
    a=math.tau*i/7 + (i//7)*.38
    reach=random.uniform(1.35,2.25) if i<7 else random.uniform(.7,1.35)
    h=random.uniform(3.5,4.65) if i<7 else random.uniform(4.65,5.3)
    start=(.03,.03,random.uniform(1.7,2.8))
    elbow=(math.cos(a)*reach*.55,math.sin(a)*reach*.55,h-.7)
    end=(math.cos(a)*reach,math.sin(a)*reach,h)
    beam("Major crooked limb",start,elbow,.11,"wood",.055,8)
    beam("Slender high bough",elbow,end,.059,"wood",.014,6)
    for j in range(3):
        aa=a+(j-1)*.52
        twig=(end[0]+.45*math.cos(aa),end[1]+.45*math.sin(aa),h+random.uniform(.15,.55))
        beam("Crown twig",elbow,twig,.025,"wood",.006,5)
        sz=(random.uniform(.6,.9),random.uniform(.55,.86),random.uniform(.42,.69))
        lobe("Irregular foliage bough",twig,sz,"leaf",2,.23)
        crown.append((twig,sz))
for i in range(7):
    a=math.tau*i/7
    p=(.9*math.cos(a),.9*math.sin(a),4.35+random.uniform(-.16,.42))
    sz=(.85,.80,.61)
    lobe("Inner crown canopy",p,sz,"leaf",2,.22)
    crown.append((p,sz))
for p,sz in crown:
    for j in range(13):
        theta=random.uniform(0,math.tau)
        elevation=random.uniform(-.5,1.3)
        surf=(p[0]+sz[0]*math.cos(theta)*math.cos(elevation),p[1]+sz[1]*math.sin(theta)*math.cos(elevation),p[2]+sz[2]*math.sin(elevation))
        leaf_spray(surf,random.uniform(.13,.23),3)
for i in range(8):
    a=random.uniform(0,math.tau)
    leaf_spray((.6*math.cos(a),.6*math.sin(a),.07),.22,5)


group("RiverMossRocks")
for p,sz in [((-.55,.15,.37),(.7,.56,.47)),((.43,.27,.52),(.64,.52,.62)),((.02,-.42,.22),(.42,.43,.27)),((.81,-.32,.13),(.25,.26,.18))]:
    lobe("Weathered limestone",p,sz,"stone",2,.22)
    lobe("Moss on rock",(p[0],p[1],p[2]+sz[2]*.61),(sz[0]*.83,sz[1]*.80,sz[2]*.27),"leaf",1,.2)
    for i in range(4):
        leaf_spray((p[0]+random.uniform(-.3,.3),p[1]+random.uniform(-.3,.3),p[2]+sz[2]*.8),.12,3)

# Join the many authoring pieces into one mesh per material per library root.
# This keeps visible detail but avoids thousands of runtime draw calls.
for root in groups:
    by_material={}
    for obj in list(root.children):
        by_material.setdefault(obj.data.materials[0].name,[]).append(obj)
    for mat,objects in by_material.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join()
        obj=bpy.context.object
        obj.name=root.name+"_"+mat
        bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
        obj.parent=root

    ground=min(vertex.co.z for obj in root.children for vertex in obj.data.vertices)
    for obj in root.children:
        for vertex in obj.data.vertices:
            vertex.co.z-=ground
        obj.data.update()

bpy.context.view_layer.update()
stats=[]
for root in groups:
    points=[obj.matrix_world@Vector(corner) for obj in root.children for corner in obj.bound_box]
    lo=[round(min(p[i] for p in points),3) for i in range(3)]
    hi=[round(max(p[i] for p in points),3) for i in range(3)]
    triangles=sum(sum(len(p.vertices)-2 for p in obj.data.polygons) for obj in root.children)
    stats.append({"name":root.name,"blender_min":lo,"blender_max":hi,"triangles":triangles,"meshes":len(root.children)})

blend_path=ROOT/"assets/art/river-kit.blend"
glb_path=ROOT/"frontend/town-2d/src/assets/river-kit.glb"
blend_path.parent.mkdir(parents=True,exist_ok=True)
glb_path.parent.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
bpy.ops.object.select_all(action="SELECT")
export_options=dict(filepath=str(glb_path),export_format="GLB",use_selection=True,export_yup=True,
                    export_texcoords=True,export_normals=True,export_materials="EXPORT",export_animations=False)
props=bpy.ops.export_scene.gltf.get_rna_type().properties
if "export_image_format" in props:
    export_options["export_image_format"]="JPEG"
if "export_jpeg_quality" in props:
    export_options["export_jpeg_quality"]=88
bpy.ops.export_scene.gltf(**export_options)
print("RIVER_KIT_ASSETS="+json.dumps(stats))
print("RIVER_KIT_BYTES="+str(glb_path.stat().st_size))

if opts.render:
    # Preview only: the saved library remains origin-centered and instanceable.
    for root,xy in zip(groups,[(-3,-3),(2.2,1.8),(-.6,-3),( -3.2,1.8),(2.4,-3)]):
        root.location=(xy[0],xy[1],0)
    current=None
    ground=material("Preview ground",(.13,.17,.115))
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(ground)
    bpy.context.object.location.z=-.055
    bpy.ops.object.camera_add(location=(13,-19,13))
    cam=bpy.context.object
    cam.rotation_euler=(Vector((0,0,2.3))-cam.location).to_track_quat("-Z","Y").to_euler()
    cam.data.type="ORTHO"
    cam.data.ortho_scale=17.5
    bpy.context.scene.camera=cam
    bpy.ops.object.light_add(type="AREA",location=(-3,-4,11))
    light=bpy.context.object
    light.data.energy=1800
    light.data.shape="DISK"
    light.data.size=7
    light.rotation_euler=(Vector((0,0,1))-light.location).to_track_quat("-Z","Y").to_euler()
    bpy.ops.object.light_add(type="SUN",location=(0,0,10))
    bpy.context.object.rotation_euler=(.45,-.4,-.5)
    bpy.context.object.data.energy=2.2
    scene=bpy.context.scene
    scene.world.color=(.18,.21,.24)
    scene.render.engine="CYCLES"
    scene.cycles.samples=24
    scene.cycles.use_denoising=True
    scene.render.resolution_x=1500
    scene.render.resolution_y=1100
    scene.render.resolution_percentage=100
    scene.view_settings.view_transform="AgX"
    preview=ROOT/"output/art/river-kit-preview.png"
    preview.parent.mkdir(parents=True,exist_ok=True)
    scene.render.filepath=str(preview)
    bpy.ops.render.render(write_still=True)
