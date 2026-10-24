import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { encodeProductMap, decodeProductMap } from "../product";
import type { ProductMapData, ProductResourceItem } from "../product";

declare global {
  interface Uint8Array {
    equals(other: Uint8Array): boolean;
  }
}

Uint8Array.prototype.equals = function(other: Uint8Array) {
  if (this.length !== other.length) return false;
  for (let i = 0; i < this.length; i++) {
    if (this[i] !== other[i]) return false;
  }
  return true;
};

describe("product protobuf", () => {
  it("round-trips data with resources", () => {
    const data: ProductMapData = {
      mapId: "test-map-001",
      payload: '{"name":"test"}',
      resources: [
        { rid: "m1", label: "model.glb", ext: "glb", blob: Buffer.from([1, 2, 3]) },
        { rid: "i1", label: "cover.png", ext: "png", blob: Buffer.from([4, 5, 6]) },
      ],
    };
    const encoded = encodeProductMap(data);
    const decoded = decodeProductMap(encoded);
    expect(decoded.mapId).toBe("test-map-001");
    expect(decoded.payload).toBe('{"name":"test"}');
    expect(decoded.resources).toHaveLength(2);
    expect(decoded.resources[0].rid).toBe("m1");
    expect(decoded.resources[0].blob.equals(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(decoded.resources[1].label).toBe("cover.png");
  });

  it("round-trips empty data", () => {
    const data: ProductMapData = { mapId: "", payload: "", resources: [] };
    const encoded = encodeProductMap(data);
    const decoded = decodeProductMap(encoded);
    expect(decoded.mapId).toBe("");
    expect(decoded.resources).toHaveLength(0);
  });
});