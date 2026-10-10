/**
 * Synthetic, original FlatBuffers-style GFBMDL test fixture containing
 * one triangle. No Nintendo geometry or proprietary game data.
 */
export function makeGfbmdlTriangle() {
  const bytes = new ArrayBuffer(512);
  const v = new DataView(bytes);
  const u16 = (o, n) => v.setUint16(o, n, true);
  const u32 = (o, n) => v.setUint32(o, n, true);
  const i32 = (o, n) => v.setInt32(o, n, true);
  const f32 = (o, n) => v.setFloat32(o, n, true);

  u32(0, 64); // root model
  u16(32, 22); u16(34, 16); // root model vtable
  u16(36, 4); // model.version
  u16(52, 8); // model.meshes (slot 8)
  i32(64, 32);
  u32(68, 2);
  u32(72, 48); // mesh vector at 120

  u32(120, 1); // one mesh
  u32(124, 68); // entry -> mesh table 192

  u16(160, 10); u16(162, 16);
  u16(164, 4); u16(166, 8); u16(168, 12);
  i32(192, 32);
  u32(196, 24); // polygon vector 220
  u32(200, 40); // attribute vector 240
  u32(204, 116); // vertex data vector 320

  u32(220, 1); u32(224, 208); // polygon table 432
  u32(240, 1); u32(244, 36); // attribute table 280

  u16(264, 10); u16(266, 16);
  u16(268, 4); u16(270, 8); u16(272, 12);
  i32(280, 16);
  u32(284, 0); // vertex semantic POSITION
  u32(288, 0); // buffer format float32
  u32(292, 3); // x y z

  u32(320, 36);
  const coords = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  coords.forEach((x, index) => f32(324 + 4 * index, x));

  u16(416, 8); u16(418, 12);
  u16(420, 4); u16(422, 8);
  i32(432, 16);
  u32(436, 0); // material 0
  u32(440, 40); // index vector at 480
  u32(480, 3);
  u16(484, 0); u16(486, 1); u16(488, 2);
  return bytes;
}
