import { spawnSync } from "child_process";

async function globalSetup() {
  // Set a RUBY_VERSION environment variable because certain tests will only run
  // for certain versions of Ruby.
  const args = ["--disable-gems", "-e", "puts RUBY_VERSION"];
  process.env.RUBY_VERSION = spawnSync("ruby", args)
    .stdout.toString("utf-8")
    .trim();
}

export default globalSetup;
