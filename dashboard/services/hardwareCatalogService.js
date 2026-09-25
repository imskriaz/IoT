'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalogPath = path.join(__dirname, '..', 'config', 'hardware-catalog.json');
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const LIMITS = { depth: 8, keys: 256, string: 512, array: 128 };

function loadCatalog() {
  const text = fs.readFileSync(catalogPath, 'utf8').replace(/^\uFEFF/, '');
  const value = JSON.parse(text);
  assertSafe(value);
  return value;
}
function assertSafe(value, depth = 0, state = { keys: 0 }) {
  if (depth > LIMITS.depth) throw new Error('catalog/config nesting exceeds limit');
  if (typeof value === 'string' && value.length > LIMITS.string) throw new Error('string exceeds limit');
  if (Array.isArray(value)) { if (value.length > LIMITS.array) throw new Error('array exceeds limit'); value.forEach(v => assertSafe(v, depth + 1, state)); return; }
  if (value && typeof value === 'object') { for (const [key, v] of Object.entries(value)) { if (FORBIDDEN.has(key)) throw new Error(`forbidden key: ${key}`); if (++state.keys > LIMITS.keys) throw new Error('object key limit exceeded'); assertSafe(v, depth + 1, state); } }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function err(errors, path, code, message) { errors.push({ path, code, message }); }
function ownObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function keysOnly(obj, allowed, at, errors) { if (!ownObject(obj)) return; for (const k of Object.keys(obj)) if (!allowed.has(k)) err(errors, `${at}.${k}`, 'unknown_field', 'field is not supported'); }

function getCatalog() { return clone(loadCatalog()); }

function validateHardwareConfiguration(configuration, options = {}) {
  const errors = [], warnings = [];
  try { assertSafe(configuration); } catch (e) { return { valid:false, errors:[{path:'configuration',code:'unsafe_input',message:e.message}], warnings:[], applyEligible:false, readiness:'invalid' }; }
  if (!ownObject(configuration)) return {valid:false,errors:[{path:'configuration',code:'type',message:'object required'}],warnings:[],applyEligible:false,readiness:'invalid'};
  keysOnly(configuration, new Set(['schema','boardId','boardVersion','modules']), 'configuration', errors);
  if (configuration.schema !== 1) err(errors,'schema','schema_version','schema must be 1');
  const catalog = loadCatalog();
  const board = catalog.boards.find(b => b.id === configuration.boardId && String(b.version) === String(configuration.boardVersion));
  if (!board) err(errors,'boardId','unknown_board','board and version are not in catalog');
  if (!Array.isArray(configuration.modules)) err(errors,'modules','type','modules array required');
  const modules = Array.isArray(configuration.modules) ? configuration.modules : [];
  if (board && modules.length > board.limits.modules) err(errors,'modules','limit','module count exceeds board limit');
  const usedPins = new Map(), usedBuses = new Map(), normalized = {schema:1,boardId:configuration.boardId,boardVersion:configuration.boardVersion,modules:[]};
  const ids = new Set();
  modules.forEach((m, i) => {
    const p = `modules[${i}]`;
    if (!ownObject(m)) { err(errors,p,'type','module object required'); return; }
    keysOnly(m,new Set(['instanceId','id','typeId','type','catalogVersion','version','enabled','bus','pins','parameters']),p,errors);
    const id = m.instanceId || m.id; const type = m.typeId || m.type; const version = m.catalogVersion || m.version;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) err(errors,`${p}.instanceId`,'identifier','valid instanceId required');
    if (ids.has(id)) err(errors,`${p}.instanceId`,'duplicate','instanceId must be unique'); ids.add(id);
    const def = catalog.modules.find(x => x.type === type && String(x.version) === String(version));
    if (!def) { err(errors,`${p}.type`,'unknown_module','module type/version is not in catalog'); return; }
    if (def.qualification !== 'qualified') warnings.push({path:p,code:'unqualified_module',message:'catalog entry is draft/reference only'});
    if (typeof m.enabled !== 'boolean' && m.enabled !== undefined) err(errors,`${p}.enabled`,'type','boolean required');
    if (!ownObject(m.parameters) && m.parameters !== undefined) err(errors,`${p}.parameters`,'type','object required');
    if (m.parameters) { try { assertSafe(m.parameters); } catch(e) { err(errors,`${p}.parameters`,'unsafe_input',e.message); } }
    if (m.bus !== undefined) {
      if (!ownObject(m.bus)) err(errors,`${p}.bus`,'type','object required'); else { keysOnly(m.bus,new Set(['type','id','address','frequencyHz']),`${p}.bus`,errors); if (typeof m.bus.type !== 'string' || typeof m.bus.id !== 'string') err(errors,`${p}.bus`,'bus','bus type and id required'); const bk=`${m.bus.type}:${m.bus.id}:${m.bus.address ?? ''}`; if (usedBuses.has(bk)) err(errors,`${p}.bus`,'bus_conflict',`bus/address already used by ${usedBuses.get(bk)}`); else usedBuses.set(bk,id); if (m.bus.address !== undefined && (!Number.isInteger(m.bus.address) || m.bus.address<0 || m.bus.address>127)) err(errors,`${p}.bus.address`,'range','I2C address must be 0..127'); }
    }
    if (m.pins !== undefined) {
      if (!ownObject(m.pins)) err(errors,`${p}.pins`,'type','object required'); else for (const [signal,pin] of Object.entries(m.pins)) { if (!Number.isInteger(pin) || pin<0 || pin>48) { err(errors,`${p}.pins.${signal}`,'pin','GPIO must be integer 0..48'); continue; } const pd=board?.pins?.[String(pin)]; if (!pd) err(errors,`${p}.pins.${signal}`,'pin_unavailable','pin absent from board manifest'); else if (pd.reservedBy) err(errors,`${p}.pins.${signal}`,'pin_reserved',`pin reserved by ${pd.reservedBy}`); if (usedPins.has(pin)) err(errors,`${p}.pins.${signal}`,'pin_conflict',`pin already used by ${usedPins.get(pin)}`); else usedPins.set(pin,id); }
    }
    const dims = m.parameters || {}; if (def.limits.width && dims.width !== undefined && (!Number.isInteger(dims.width)||dims.width<1||dims.width>def.limits.width)) err(errors,`${p}.parameters.width`,'limit','width exceeds module limit'); if (def.limits.height && dims.height !== undefined && (!Number.isInteger(dims.height)||dims.height<1||dims.height>def.limits.height)) err(errors,`${p}.parameters.height`,'limit','height exceeds module limit');
    normalized.modules.push({instanceId:id,typeId:type,catalogVersion:String(version),enabled:m.enabled !== false,bus:m.bus?clone(m.bus):undefined,pins:m.pins?clone(m.pins):undefined,parameters:m.parameters?clone(m.parameters):{}});
  });
  const manifest = options.manifest;
  if (!manifest) warnings.push({path:'manifest',code:'missing_driver_manifest',message:'device driver manifest required before apply'});
  else if (ownObject(manifest) && Array.isArray(manifest.drivers)) for (const m of catalog.modules) if (normalized.modules.some(x=>x.typeId===m.type) && !manifest.drivers.some(d=>d && d.id===m.driver)) err(errors,'manifest','missing_driver',`driver ${m.driver} not reported by device`);
  const valid = errors.length===0; return {valid,errors,warnings,configuration:valid?normalized:undefined,configHash:valid?hash(normalized):undefined,applyEligible:false,readiness:valid?'configured_unverified':'invalid',catalogVersion:catalog.catalogVersion};
}
module.exports = { getCatalog, validateHardwareConfiguration };
