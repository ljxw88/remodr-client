#!/usr/bin/env node
const { readFile, writeFile, rename, unlink } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { modelCatalogueSchema, catalogueProviderSchema } = require('../src/domain/model-catalogue-schema.ts');
const { discover } = require('./model-sources.cjs');

const CATALOGUE_DIR = path.join(path.dirname(require.resolve('../src/domain/model-catalogue-schema.ts')), 'model-catalogues');

function parseArgs(args) {
  const options = { providers: [], dryRun: false, check: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--provider') {
      const values = args[++index]?.split(',');
      if (!values?.length) throw new Error('--provider requires a provider name');
      options.providers.push(...values.map((value) => catalogueProviderSchema.parse(value)));
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (options.check && options.dryRun) throw new Error('--check and --dry-run are mutually exclusive');
  options.providers = [...new Set(options.providers.length ? options.providers : catalogueProviderSchema.options)];
  return options;
}

async function readCatalogue(provider, directory = CATALOGUE_DIR) {
  const catalogue = modelCatalogueSchema.parse(JSON.parse(await readFile(path.join(directory, `${provider}.json`), 'utf8')));
  if (catalogue.provider !== provider) throw new Error(`${provider}: catalogue provider mismatch`);
  return catalogue;
}

async function writeCatalogue(catalogue, directory = CATALOGUE_DIR) {
  const valid = modelCatalogueSchema.parse(catalogue);
  if (!valid.models.length) throw new Error(`${valid.provider}: refusing an empty discovery result`);
  const destination = path.join(directory, `${valid.provider}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function refresh(options, { directory = CATALOGUE_DIR, fetchProvider = discover, log = console.log } = {}) {
  if (options.check) {
    for (const provider of options.providers) {
      const catalogue = await readCatalogue(provider, directory);
      log(`${provider}: ${catalogue.models.length} models; snapshot ${catalogue.updatedAt ?? 'not refreshed'}`);
    }
    return;
  }
  const fetched = [];
  // Fetch and validate everything before changing any checked-in snapshot.
  for (const provider of options.providers) {
    const catalogue = modelCatalogueSchema.parse(await fetchProvider(provider));
    if (catalogue.provider !== provider) throw new Error(`${provider}: discovery provider mismatch`);
    if (!catalogue.models.length) throw new Error(`${provider}: refusing an empty discovery result`);
    fetched.push(catalogue);
  }
  for (const catalogue of fetched) {
    if (!options.dryRun) await writeCatalogue(catalogue, directory);
    log(`${catalogue.provider}: ${catalogue.models.length} models${options.dryRun ? ' (dry run; not written)' : ' updated'}`);
    for (const note of catalogue.notes) log(`  ${note}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run models:refresh -- [--provider copilot,codex,claude,cursor] [--dry-run | --check]');
    console.log('Run discovery on a maintenance machine with the selected CLIs installed and authenticated.');
    return;
  }
  await refresh(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Model refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, readCatalogue, writeCatalogue, refresh };
