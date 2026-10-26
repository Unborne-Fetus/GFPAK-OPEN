/**
 * Experimental Game Freak skeletal animation FlatBuffers decoder.
 * Supports Trinity TRANM and compatible GF GFBANM structure:
 * per-bone fixed, densely framed, keyed 8-bit and keyed 16-bit channels.
 *
 * Source layouts: GFTool.Core/Flatbuffers/TR/Animation/SkeletalAnimation.cs
 * and GFTool.Core/Flatbuffers/GF/Animation/GfAnimation.cs.
 * Does not cover all later Z-A/Scarlet animations or proprietary shader tracks.
 */
import { FlatModelReader } from './gfbmdl.js';

export class NativeAnimationError extends Error {
  constructor(message) { super(message); this.name = 'NativeAnimationError'; }
}

const MAX_TRACKS = 4096;
const MAX_FRAMES = 120000;
const MAX_POINTS = 240000;

function table(reader, parent, slot) {
  const at = reader.field(parent, slot);
  return at ? reader.table(reader.pointer(at)) : null;
}

function samples(reader, parent, slot, vectorSize, sample) {
  const vector = reader.vector(parent, slot, vectorSize);
  if (!vector) return [];
  if (vector.count > MAX_POINTS) throw new NativeAnimationError('Animation track is too large');
  return Array.from({ length: vector.count }, (_, i) => sample(vector.start + i * vectorSize));
}

function readVec3(reader, pos) {
  reader.ensure(pos, 12);
  return [reader.f32(pos), reader.f32(pos + 4), reader.f32(pos + 8)];
}

/**
 * PackedQuaternion XYZW has three ushort values packing the least significant
 * components and a two-bit omitted-component index. Return Three.js XYZW.
 */
export function unpackQuaternion(x, y, z) {
  const word = BigInt(x) | BigInt(y) << 16n | BigInt(z) << 32n;
  // Quaternion components are unitless. Smallest-three compression stores
  // them over [-1/sqrt(2), +1/sqrt(2)], not angles in radians. The old
  // +/-PI/4 range distorted distal bones (tongue, vines, and small limbs).
  const componentLimit = Math.SQRT1_2;
  const value = shift => (Number(word >> BigInt(shift) & 0x7FFFn) /
    32767 * 2 - 1) * componentLimit;
  const q1 = value(3), q2 = value(18), q3 = value(33);
  const square = q1*q1 + q2*q2 + q3*q3;
  const omitted = Math.sqrt(Math.max(0, 1 - square));
  const index = Number(word & 3n);
  const negative = (word & 4n) !== 0n;
  const result = [q1, q2, q3];
  result.splice(index, 0, omitted);
  if (negative) result.forEach((_, i) => { result[i] = -result[i]; });
  const length = Math.hypot(...result);
  if (length > 0) return result.map(component => component / length);
  return [0, 0, 0, 1];
}

function readQuat(reader, pos) {
  reader.ensure(pos, 6);
  return unpackQuaternion(reader.u16(pos), reader.u16(pos + 2), reader.u16(pos + 4));
}

function dataChannel(reader, parent, kind, typeSlot) {
  const type = reader.field(parent, typeSlot) ? reader.u8(reader.field(parent, typeSlot)) : 0;
  if (!type) return null;
  const contentSlot = typeSlot + 1;
  const content = table(reader, parent, contentSlot);
  if (!content) throw new NativeAnimationError('Missing animation channel table');
  const quaternion = kind === 'rotation';
  const stride = quaternion ? 6 : 12;
  const readerFn = pos => quaternion ? readQuat(reader, pos) : readVec3(reader, pos);
  let frames, values;
  switch (type) {
    case 1: {
      const at = reader.field(content, 0);
      if (!at) throw new NativeAnimationError('Fixed keyframe is missing');
      frames = [0];
      values = [readerFn(at)];
      break;
    }
    case 2:
      values = samples(reader, content, 0, stride, readerFn);
      frames = Array.from({ length: values.length }, (_, i) => i);
      break;
    case 3:
      frames = samples(reader, content, 0, 2, pos => reader.u16(pos));
      values = samples(reader, content, 1, stride, readerFn);
      break;
    case 4:
      frames = samples(reader, content, 0, 1, pos => reader.u8(pos));
      values = samples(reader, content, 1, stride, readerFn);
      break;
    default:
      throw new NativeAnimationError('Unsupported native animation channel type ' + type);
  }
  const n = Math.min(frames.length, values.length);
  if (!n) return null;
  if (n > MAX_POINTS) throw new NativeAnimationError('Too many animation keyframes');
  const keyframes = [];
  for (let i = 0; i < n; i++) {
    if (frames[i] >= 0 && frames[i] <= MAX_FRAMES) {
      if (keyframes.length && frames[i] <= keyframes.at(-1).frame) continue;
      if (values[i].every(Number.isFinite)) keyframes.push({ frame: frames[i], value: values[i] });
    }
  }
  return keyframes.length ? keyframes : null;
}

export function parseNativeAnimation(bytes, filename = 'model.tranm') {
  let reader;
  try { reader = new FlatModelReader(bytes); }
  catch (error) { throw new NativeAnimationError(error.message); }
  try {
    const root = reader.table(reader.root());
    const info = table(reader, root, 0);
    const skeletal = table(reader, root, 1);
    if (!info || !skeletal) throw new NativeAnimationError('Animation has no playback or skeleton information');
    const frameCount = reader.uint(info, 1);
    const frameRate = reader.uint(info, 2) || 30;
    if (frameCount > MAX_FRAMES || frameRate > 1000)
      throw new NativeAnimationError('Animation frame/rate exceeds sanity limits');
    const tracks = reader.objects(skeletal, 0, MAX_TRACKS).map(track => ({
      bone: reader.string(track, 0),
      scale: dataChannel(reader, track, 'scale', 1),
      rotation: dataChannel(reader, track, 'rotation', 3),
      translation: dataChannel(reader, track, 'translation', 5)
    })).filter(track => track.bone && (track.scale || track.rotation || track.translation));
    if (!tracks.length) throw new NativeAnimationError('No skeletal keyframes could be decoded');
    return {
      name: filename.replace(/\.[^.]+$/, ''), frameCount, frameRate,
      looped: reader.uint(info, 0) !== 0, tracks
    };
  } catch (error) {
    if (error instanceof NativeAnimationError) throw error;
    throw new NativeAnimationError('Could not decode native animation: ' + error.message);
  }
}
