#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };

process.stdout.write(`${packageJson.version}\n`);
