/**
 * Bake Game Freak segment-scale compensation into glTF-exportable bone TRS.
 *
 * The native viewer uses NativeBone.updateMatrix() to multiply a child's local
 * matrix by the inverse of its parent's animated scale. glTF has no equivalent
 * "segment scale compensate" switch. GLTFExporter serializes Bone.position /
 * quaternion / scale, not NativeBone's custom matrix; therefore straight GLB
 * exports can deform distal geometry even when GFPAK's preview looks correct.
 *
 * Keep the source rig untouched outside the exporter transaction.
 */
import * as THREE from 'three';

const MAX_SAMPLES_PER_CLIP = 1200;
const TARGET_FPS = 30;
const SHEAR_TOLERANCE = 0.012;

function transformSnapshot(root) {
  const saved = [];
  root.traverse(node => saved.push({
    node,
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone(),
    visible: node.visible,
    compensated: node.segmentScaleCompensate
  }));
  return () => {
    for (const state of saved) {
      state.node.position.copy(state.position);
      state.node.quaternion.copy(state.quaternion);
      state.node.scale.copy(state.scale);
      state.node.visible = state.visible;
      if (state.compensated !== undefined)
        state.node.segmentScaleCompensate = state.compensated;
    }
    root.updateMatrixWorld(true);
  };
}

function readableTransform(bone) {
  const translation = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  bone.matrix.decompose(translation, quaternion, scale);
  const reconstructed = new THREE.Matrix4().compose(translation, quaternion, scale);
  const actual = bone.matrix.elements, calculated = reconstructed.elements;
  let difference = 0;
  for (let i = 0; i < 16; i++) {
    const size = Math.max(1, Math.abs(actual[i]));
    difference = Math.max(difference, Math.abs(actual[i] - calculated[i]) / size);
  }
  if (![...translation.toArray(), ...quaternion.toArray(), ...scale.toArray()]
      .every(Number.isFinite) || difference > SHEAR_TOLERANCE) {
    throw new Error('Cannot faithfully export segment-scale-compensated bone "' +
      bone.name + '". Native pose contains non-TRS shear; original model was kept.');
  }
  return { translation, quaternion, scale };
}

function sampleTimes(duration) {
  if (!(duration > 0) || !Number.isFinite(duration)) return [0];
  const intervals = Math.min(MAX_SAMPLES_PER_CLIP - 1, Math.max(1,
    Math.ceil(duration * TARGET_FPS)));
  return Array.from({ length: intervals + 1 }, (_, i) => duration * i / intervals);
}

function bakeClip(root, clip, affected, restore) {
  restore();
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const times = sampleTimes(clip.duration);
  const values = new Map(affected.map(bone => [bone, {
    position: [], quaternion: [], scale: [], lastQuaternion: null
  }]));
  try {
    for (const time of times) {
      mixer.setTime(time);
      root.updateMatrixWorld(true);
      for (const bone of affected) {
        const pose = readableTransform(bone);
        const record = values.get(bone);
        const q = pose.quaternion;
        if (record.lastQuaternion && q.dot(record.lastQuaternion) < 0)
          q.set(-q.x, -q.y, -q.z, -q.w);
        record.position.push(...pose.translation);
        record.quaternion.push(...q);
        record.scale.push(...pose.scale);
        record.lastQuaternion = q.clone();
      }
    }
  } finally {
    action.stop();
    mixer.uncacheRoot(root);
    restore();
  }
  const superseded = new Set(affected.flatMap(bone => [
    bone.name + '.position', bone.name + '.quaternion', bone.name + '.scale'
  ]));
  const tracks = clip.tracks.filter(track => !superseded.has(track.name));
  for (const bone of affected) {
    const record = values.get(bone);
    tracks.push(new THREE.VectorKeyframeTrack(bone.name + '.position',
      times, record.position));
    tracks.push(new THREE.QuaternionKeyframeTrack(bone.name + '.quaternion',
      times, record.quaternion));
    tracks.push(new THREE.VectorKeyframeTrack(bone.name + '.scale',
      times, record.scale));
  }
  const result = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  if (!result.validate()) throw new Error('Compensated animation failed glTF validation');
  return result;
}

/**
 * Called only immediately before GLTFExporter.parseAsync().
 * Returns an exportable animation list and a restore() function that must run
 * in a finally block, whether export succeeds or fails.
 */
export function prepareRiggedGlbExport(root, animations = []) {
  const affected = [];
  root.traverse(node => {
    if (node.isBone && node.segmentScaleCompensate === true && node.parent?.isBone)
      affected.push(node);
  });
  if (!affected.length) return { animations, restore() {}, compensatedBones: 0 };
  const restore = transformSnapshot(root);
  try {
    const names = affected.map(bone => bone.name);
    if (new Set(names).size !== names.length || names.some(name => !name)) {
      throw new Error('Cannot safely export ambiguous segment-scale-compensated bone names');
    }
    root.updateMatrixWorld(true);
    const rest = new Map(affected.map(bone => [bone, readableTransform(bone)]));
    const baked = animations.map(clip => bakeClip(root, clip, affected, restore));
    restore();
    // Bake native local compensated matrices as authored glTF TRS rest values.
    // The original native skeleton's inverse bind matrices remain valid because
    // the resulting world matrices are equivalent to the native rest matrices.
    for (const bone of affected) {
      const pose = rest.get(bone);
      bone.segmentScaleCompensate = false;
      bone.position.copy(pose.translation);
      bone.quaternion.copy(pose.quaternion);
      bone.scale.copy(pose.scale);
    }
    root.updateMatrixWorld(true);
    return { animations: baked, restore, compensatedBones: affected.length };
  } catch (error) {
    restore();
    throw error;
  }
}
