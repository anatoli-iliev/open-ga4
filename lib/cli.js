#!/usr/bin/env node
import { main } from "./cli/main.js";
import { processStreams } from "./cli/render.js";

process.exit(await main(process.argv.slice(2), process.env, processStreams));
