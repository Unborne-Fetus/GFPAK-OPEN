import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopEffectPreview, previewEffectKind} from '../src/desktop-effects.js';

function sampleMaterial(shader = 'PokeFireCoreShader') {
  const texture = {
    isTexture:true, name:'native fire palette',
    offset:{x:0,y:0},
    clone() {
      return { ...this, offset:{...this.offset},
        dispose() { this.disposed = true; } };
    }
  };
  return {
    name:'EffectLayer', map:texture, emissiveMap:texture,
    emissiveIntensity:2, transparent:true, depthWrite:true,
    opacity:1, colorWrite:true,
    userData:{gfpakNativeShader:shader},
  };
}
function rootWith(materials) {
  return {traverse(fn) {
    for (const material of materials)
      fn({isMesh:true,material});
  }};
}

test('fire shader labels identify motion-capable materials, never hidden fire masks', () => {
  const core = sampleMaterial();
  const mask = sampleMaterial('PokeFireMaskShader');
  assert.equal(previewEffectKind(core), 'fire');
  assert.equal(previewEffectKind(mask), '');
  assert.equal(previewEffectKind({name:'body',map:core.map}), '');
});

test('effect controls clone texture wrappers and reverse every change on disable', () => {
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 123;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const material = sampleMaterial();
    const originalMap = material.map;
    const status = [];
    const runtime = new DesktopEffectPreview(next => status.push(next));
    runtime.attach(rootWith([material]));
    assert.equal(material.map, originalMap);
    runtime.setSpeed(99);
    runtime.setIntensity(-7);
    assert.equal(runtime.speed, 3);
    assert.equal(runtime.intensity, 0);
    runtime.setEnabled(true);
    assert.notEqual(material.map, originalMap);
    assert.equal(material.emissiveMap, material.map);
    assert.equal(status.at(-1).count, 1);
    runtime.setEnabled(false);
    assert.equal(material.map, originalMap);
    assert.equal(material.emissiveMap, originalMap);
    assert.equal(material.emissiveIntensity, 2);
    assert.equal(material.depthWrite, true);
    runtime.dispose();
  } finally {
    globalThis.requestAnimationFrame = oldRequest;
    globalThis.cancelAnimationFrame = oldCancel;
  }
});

test('smoke materials retain alpha; shared maps are not animated on body meshes', () => {
  const smoke = sampleMaterial('GasSmokeShader');
  smoke.name = 'smoke';
  const body = sampleMaterial('BodyShader');
  body.name = 'body';
  body.map.name = 'skin texture';
  assert.equal(previewEffectKind(smoke), 'smoke');
  assert.equal(previewEffectKind(body), '');
});
