// Integration tests for server isolation.
//
// These tests verify that formatting Ruby files produces consistent output
// regardless of whether markdown files with embedded Ruby are also processed.
//
// The bug: the plugin spawned a single Ruby server whose syntax_tree plugins
// were determined by whichever file triggered the first parse() call. When a
// markdown file with a ```ruby fenced block was processed first, Prettier
// passed the markdown parser's resolved options (trailingComma: "all") instead
// of the ruby plugin's defaults (trailingComma: "none"). This loaded the
// trailing_comma plugin into the shared server, adding trailing commas to
// every subsequent .rb file.
//
// These tests run prettier as a subprocess so each invocation gets a fresh
// module and spawns its own server processes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(url.fileURLToPath(import.meta.url), "../../..");
const PRETTIER = path.join(ROOT, "node_modules/.bin/prettier");
const PLUGIN = path.join(ROOT, "src/plugin.js");

// A Ruby snippet whose formatting changes when the trailing_comma plugin is
// loaded. The argument names are long enough that they always wrap to multiple
// lines at printWidth 80 (the ruby plugin default), which means the
// trailing_comma plugin will append a comma after the last argument.
const RUBY_SOURCE = `\
class Example
  def call
    some_long_method_name(
      first_really_long_argument,
      second_really_long_argument
    )
  end
end
`;

// Markdown containing a ```ruby fenced block with hash-rocket syntax.
// This is the trigger: when prettier formats this file, the embedded ruby
// parser may receive trailingComma: "all" from the markdown parser context.
const MARKDOWN_SOURCE = `\
# Example

\`\`\`ruby
SORT_KEYS = {
  RelativeTime => [:created_at],
  Status => [:status]
}
\`\`\`
`;

// Minimal prettierrc that matches the ruby plugin's own defaults.
const PRETTIERRC = JSON.stringify({ plugins: [PLUGIN] });

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prettier-ruby-test-"));
  // Write a prettierrc so prettier resolves config consistently.
  fs.writeFileSync(path.join(dir, ".prettierrc.json"), PRETTIERRC);
  return dir;
}

function runPrettierStatus(args, opts = {}) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [PRETTIER, "--plugin", PLUGIN, ...args],
      {
        cwd: opts.cwd || ROOT,
        input: opts.input,
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("server isolation", () => {
  it("formatting .rb alone produces same output as with .md present", () => {
    // Format ruby in isolation.
    const isolatedDir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(isolatedDir, "sample.rb"), RUBY_SOURCE);
      runPrettierStatus(["--write", isolatedDir]);
      const isolated = fs.readFileSync(
        path.join(isolatedDir, "sample.rb"),
        "utf-8"
      );

      // Format the same ruby with a markdown file present.
      const mixedDir = makeTmpDir();
      try {
        fs.writeFileSync(path.join(mixedDir, "a_docs.md"), MARKDOWN_SOURCE);
        fs.writeFileSync(path.join(mixedDir, "b_sample.rb"), RUBY_SOURCE);
        runPrettierStatus(["--write", mixedDir]);
        const withMarkdown = fs.readFileSync(
          path.join(mixedDir, "b_sample.rb"),
          "utf-8"
        );

        assert.equal(
          withMarkdown,
          isolated,
          "Formatting .rb with .md present produced different output " +
            "than formatting .rb alone.\n" +
            `Isolated:\n${isolated}\nWith markdown:\n${withMarkdown}`
        );
      } finally {
        fs.rmSync(mixedDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it("does not add trailing commas from markdown context", () => {
    const dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, "a_docs.md"), MARKDOWN_SOURCE);
      fs.writeFileSync(path.join(dir, "b_sample.rb"), RUBY_SOURCE);

      runPrettierStatus(["--write", dir]);
      const result = fs.readFileSync(path.join(dir, "b_sample.rb"), "utf-8");

      // The trailing_comma plugin would turn "second_really_long_argument\n"
      // into "second_really_long_argument,\n". Verify this didn't happen.
      assert.ok(
        !result.includes("second_really_long_argument,"),
        "Trailing comma was added to .rb file — " +
          "markdown context leaked into ruby server.\n" +
          `Formatted output:\n${result}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
