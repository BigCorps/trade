#!/usr/bin/env node

/**
 * Corrige os escapes literais inseridos pelo primeiro pacote Markdown.
 *
 * Uso na raiz do projeto:
 *   node fix-main-markdown-escapes.mjs
 *   npm run build
 *
 * Altera somente o bloco copyAnalysisMarkdown dentro de app/page.tsx.
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const targetPath = resolve(process.cwd(), 'app/page.tsx');
const backupPath = resolve(
  process.cwd(),
  'app/page.tsx.before-markdown-escape-fix',
);

if (!existsSync(targetPath)) {
  throw new Error(`Arquivo não encontrado: ${targetPath}`);
}

let source = readFileSync(targetPath, 'utf8');

const startMarker =
  '  const copyAnalysisMarkdown = useCallback(async () => {';
const endMarker = '  const select = (\n    value: string,';

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0 || end <= start) {
  throw new Error(
    'Não encontrei o bloco copyAnalysisMarkdown esperado. ' +
      'Confirme se o pacote anterior foi aplicado.',
  );
}

const before = source.slice(0, start);
const block = source.slice(start, end);
const after = source.slice(end);

const escapedBackticks = (block.match(/\\`/g) ?? []).length;
const escapedInterpolations = (block.match(/\\\$\{/g) ?? []).length;

if (escapedBackticks === 0 && escapedInterpolations === 0) {
  console.log(
    'O bloco não contém mais escapes incorretos. Nenhuma alteração foi necessária.',
  );
  process.exit(0);
}

const fixedBlock = block
  .replaceAll('\\`', '`')
  .replaceAll('\\${', '${');

if (!existsSync(backupPath)) {
  copyFileSync(targetPath, backupPath);
}

source = before + fixedBlock + after;
writeFileSync(targetPath, source, 'utf8');

console.log('Correção concluída em app/page.tsx.');
console.log(`Backticks corrigidos: ${escapedBackticks}`);
console.log(`Interpolações corrigidas: ${escapedInterpolations}`);
console.log('Backup: app/page.tsx.before-markdown-escape-fix');
console.log('Agora execute: npm run build');
