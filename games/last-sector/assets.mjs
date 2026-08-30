export const ASSETS = Object.freeze({
  scout: 'ship-scout',
  transport: 'ship-transport',
  warship: 'ship-warship',
  tanker: 'ship-tanker',
  planet: 'object-planet',
  station: 'object-station',
  base: 'object-base',
  asteroid: 'object-asteroid',
  pirate: 'object-pirate',
  nebula: 'object-nebula',
  signal: 'object-signal',
  accelerator: 'object-accelerator',
  teleport: 'object-teleport',
  anomaly: 'object-anomaly',
  blackhole: 'object-blackhole',
});

export function createAssetIcon(documentRef, asset, options = {}) {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.className = options.className || 'ls-asset';
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', options.ariaHidden === false ? 'false' : 'true');
  if (options.title) svg.setAttribute('title', options.title);
  const use = documentRef.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `../assets.svg#${ASSETS[asset] || 'object-default'}`);
  svg.appendChild(use);
  return svg;
}

export function assetName(kind) {
  return ASSETS[kind] ? kind : 'default';
}
