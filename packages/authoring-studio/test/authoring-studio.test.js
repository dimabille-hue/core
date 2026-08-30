import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORING_API_VERSION } from '@tablecore/authoring-sdk';
import { AuthoringStudioModel } from '../src/index.js';

function demoBundle() {
  return {
    manifest: { id: 'studio-demo', name: 'Studio Demo', version: '1.0.0', authoringApiVersion: AUTHORING_API_VERSION },
    editor: { categories: ['objects', 'maps', 'rules'] },
    schemas: {
      objects: { object: { fields: [
        { id: 'collectible', type: 'boolean', default: false },
        { id: 'value', type: 'integer', min: 0, max: 99, default: 1 },
        { id: 'terrain', type: 'ref', group: 'terrains' },
      ] } },
      terrains: { terrain: { fields: [{ id: 'fuel_cost', type: 'integer', min: 0, max: 9, default: 1 }] } },
      maps: { map: { fields: [{ id: 'radius', type: 'integer', min: 1, max: 20, default: 2 }] } },
      rules: { rule: { fields: [{ id: 'value', type: 'number', required: true }] } },
    },
    content: { objects: {}, terrains: {}, maps: {}, rules: {} },
  };
}

test('studio creates and selects a data entity through declared schema', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  const entity = studio.create('objects', 'object', 'crate', { collectible: true, value: 5, terrain: 'plain' });
  assert.equal(entity.id, 'crate');
  assert.equal(entity.fields.value, 5);
  assert.equal(studio.getSchema('objects').fields[1].id, 'value');
});

test('studio edits data without changing schema', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  studio.setField('objects', 'crate', 'value', 7);
  assert.equal(studio.getSchema('objects').fields[1].type, 'integer');
  assert.equal(studio.getSelection().fields.value, 7);
});

test('studio rejects undeclared editor fields', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  assert.throws(() => studio.setField('objects', 'crate', 'unknown', 1));
});

test('studio validation uses the authoring SDK validator', () => {
  const studio = new AuthoringStudioModel(demoBundle());
  studio.create('objects', 'object', 'crate');
  assert.deepEqual(studio.validate(), []);
});
