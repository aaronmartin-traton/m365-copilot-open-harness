#!/usr/bin/env bun

import { OPENCLAW_DISABLED_MESSAGE } from "./index.js";

process.stderr.write(`${OPENCLAW_DISABLED_MESSAGE}\n`);
process.exitCode = 1;
