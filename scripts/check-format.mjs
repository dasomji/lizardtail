#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import * as prettier from "prettier";

try {
  const paths = process.argv.slice(2);
  const candidates = paths.length
    ? paths
    : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
        .split("\0")
        .filter(Boolean);
  const files = [];
  for (const file of candidates) {
    if (
      /(^|\/)(node_modules|dist|coverage|vendor|evidence|\.kitchen|\.git)(\/|$)/.test(
        file,
      )
    )
      continue;
    if (!lstatSync(file).isFile()) continue;
    const info = await prettier.getFileInfo(file, {
      ignorePath: ".prettierignore",
    });
    if (!info.ignored && info.inferredParser) files.push(file);
  }
  if (!files.length) {
    if (!paths.length)
      throw Error("No supported first-party files selected for formatting");
    console.log(
      "No Prettier-supported staged files; typecheck/build/tests still apply.",
    );
  } else {
    const result = spawnSync(
      process.execPath,
      ["node_modules/prettier/bin/prettier.cjs", "--check", "--", ...files],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(`Formatting failed: ${error.message}`);
  process.exitCode = 1;
}
