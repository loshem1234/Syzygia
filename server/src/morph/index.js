import { createMorpheusClient } from './morpheus.js';

let morph;
export function getMorph() { if (!morph) morph = createMorpheusClient(); return morph; }
export function setMorph(m) { morph = m; }
