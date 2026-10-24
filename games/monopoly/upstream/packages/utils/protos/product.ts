import { Writer, Reader } from "protobufjs/minimal";

export interface ProductResourceItem {
  rid: string;
  label: string;
  ext: string;
  blob: Uint8Array;
}

export interface ProductMapData {
  mapId: string;
  payload: string;
  resources: ProductResourceItem[];
  serverMapId?: string;
}

// Tag bytes: (fieldNumber << 3) | wireType
// wire type 2 = length-delimited (string, bytes, messages)
const TAG_MAP_ID = (5 << 3) | 2; // 42
const TAG_PAYLOAD = (8 << 3) | 2; // 66
const TAG_RESOURCES = (3 << 3) | 2; // 26
const TAG_SERVER_MAP_ID = (9 << 3) | 2; // 74
const TAG_RID = (2 << 3) | 2; // 18
const TAG_LABEL = (6 << 3) | 2; // 50
const TAG_EXT = (7 << 3) | 2; // 58
const TAG_BLOB = (4 << 3) | 2; // 34

export function encodeProductMap(data: ProductMapData): Uint8Array {
  const writer = Writer.create();
  if (data.mapId) writer.uint32(TAG_MAP_ID).string(data.mapId);
  if (data.payload) writer.uint32(TAG_PAYLOAD).string(data.payload);
  for (const r of data.resources) {
    writer.uint32(TAG_RESOURCES).fork();
    if (r.rid) writer.uint32(TAG_RID).string(r.rid);
    if (r.label) writer.uint32(TAG_LABEL).string(r.label);
    if (r.ext) writer.uint32(TAG_EXT).string(r.ext);
    if (r.blob.length) writer.uint32(TAG_BLOB).bytes(r.blob);
    writer.ldelim();
  }
  if (data.serverMapId) writer.uint32(TAG_SERVER_MAP_ID).string(data.serverMapId);
  return writer.finish();
}

export function decodeProductMap(buffer: Uint8Array): ProductMapData {
  const reader = Reader.create(buffer);
  const data: ProductMapData = { mapId: "", payload: "", resources: [], serverMapId: "" };
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 5:
        data.mapId = reader.string();
        break;
      case 8:
        data.payload = reader.string();
        break;
      case 9:
        data.serverMapId = reader.string();
        break;
      case 3: {
        const len = reader.uint32();
        const end = reader.pos + len;
        const item: ProductResourceItem = { rid: "", label: "", ext: "", blob: new Uint8Array(0) };
        while (reader.pos < end) {
          const t = reader.uint32();
          switch (t >>> 3) {
            case 2: item.rid = reader.string(); break;
            case 6: item.label = reader.string(); break;
            case 7: item.ext = reader.string(); break;
            case 4: item.blob = reader.bytes(); break;
            default: reader.skipType(t & 7);
          }
        }
        data.resources.push(item);
        reader.pos = end;
        break;
      }
      default:
        reader.skipType(tag & 7);
    }
  }
  return data;
}