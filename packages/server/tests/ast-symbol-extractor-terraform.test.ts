import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'module';
import { extractSymbolsForChunks } from '../src/ast-symbol-extractor.js';

const require = createRequire(import.meta.url);

let parser: Parser;
let language: Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const wasmPath =
    require.resolve('@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm');
  language = await Language.load(wasmPath);
  parser.setLanguage(language);
});

afterAll(() => {
  parser?.delete();
});

// Real snippet shapes from ../terraforms (inlined so tests are hermetic).
const SAMPLE = `terraform {
  required_version = ">= 1.14.0"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

locals {
  name = "app-\${var.region}"
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.micro"
  subnet_id     = module.network.subnet_id
  region        = var.region
}

module "network" {
  source = "./modules/network"
  region = var.region
}

output "instance_id" {
  value = resource.aws_instance.web.id
}
`;

function parseChunks(chunks: Array<{ startLine: number; endLine: number }>) {
  const tree = parser.parse(SAMPLE);
  const results = extractSymbolsForChunks(tree!, language, chunks, 'terraform');
  tree!.delete();
  return results;
}

function parseAll() {
  const lineCount = SAMPLE.split('\n').length;
  return parseChunks([{ startLine: 0, endLine: lineCount }])[0]!;
}

describe('extractSymbolsForChunks (terraform)', () => {
  it('extracts composite block definitions', () => {
    const r = parseAll();
    // resource/data definitions are bare `<type>.<name>` (referenced bare in HCL)
    expect(r.defines_symbols).toContain('aws_instance.web');
    expect(r.defines_symbols).toContain('aws_ami.ubuntu');
    // variable/module/output definitions carry their reference scope prefix
    expect(r.defines_symbols).toContain('module.network');
    expect(r.defines_symbols).toContain('var.region');
    expect(r.defines_symbols).toContain('output.instance_id');
  });

  it('extracts reference usages that match their definitions exactly', () => {
    // Isolate the resource block (which holds the references) in its own chunk so
    // its usages are not cancelled by definitions of the same symbol elsewhere —
    // this mirrors how real files chunk into separate blocks.
    const lines = SAMPLE.split('\n');
    const start = lines.findIndex((l) => l.startsWith('resource "aws_instance"'));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    const r = parseChunks([{ startLine: start, endLine: end }])[0]!;

    expect(r.uses_symbols).toContain('module.network');
    // `data.aws_ami.ubuntu` strips the `data.` scope to match the bare data def
    expect(r.uses_symbols).toContain('aws_ami.ubuntu');
    expect(r.uses_symbols).toContain('var.region');
  });

  it('tags definition kinds by block type', () => {
    const r = parseAll();
    const web = r.defined_symbols.find((d) => d.name === 'aws_instance.web');
    expect(web?.kind).toBe('resource');
    const variable = r.defined_symbols.find((d) => d.name === 'var.region');
    expect(variable?.kind).toBe('variable');
    const mod = r.defined_symbols.find((d) => d.name === 'module.network');
    expect(mod?.kind).toBe('module');
  });
});
