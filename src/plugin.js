import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import process from "process";
import url from "url";
import { resolveConfigFile } from "prettier";

// In order to properly parse ruby code, we need to tell the ruby process to
// parse using UTF-8. Unfortunately, the way that you accomplish this looks
// differently depending on your platform.
function getLang() {
  const { env, platform } = process;
  const envValue = env.LC_ALL || env.LC_CTYPE || env.LANG;

  // If an env var is set for the locale that already includes UTF-8 in the
  // name, then assume we can go with that.
  if (envValue && envValue.includes("UTF-8")) {
    return envValue;
  }

  // Otherwise, we're going to guess which encoding to use based on the system.
  // This is probably not the best approach in the world, as you could be on
  // linux and not have C.UTF-8, but in that case you're probably passing an env
  // var for it. This object below represents all of the possible values of
  // process.platform per:
  // https://nodejs.org/api/process.html#process_process_platform
  return {
    aix: "C.UTF-8",
    android: "C.UTF-8",
    cygwin: "C.UTF-8",
    darwin: "en_US.UTF-8",
    freebsd: "C.UTF-8",
    haiku: "C.UTF-8",
    linux: "C.UTF-8",
    netbsd: "C.UTF-8",
    openbsd: "C.UTF-8",
    sunos: "C.UTF-8",
    win32: ".UTF-8"
  }[platform];
}

// Return the list of plugins that should be passed to the server process.
function getPlugins(opts) {
  const plugins = new Set();

  const rubyPlugins = opts.rubyPlugins.trim();
  if (rubyPlugins.length > 0) {
    rubyPlugins.split(",").forEach((plugin) => plugins.add(plugin.trim()));
  }

  if (opts.rubySingleQuote) {
    plugins.add("plugin/single_quotes");
  }

  if (opts.trailingComma !== "none") {
    plugins.add("plugin/trailing_comma");
  }

  return Array.from(plugins);
}

// Counter to ensure unique temp file paths when spawning multiple servers
// with different plugin configurations.
let serverCounter = 0;

// Create a file that will act as a communication mechanism, spawn a parser
// server with that filepath as an argument, then wait for the file to be
// created that will contain the connection information.
export async function spawnServer(opts, killOnExit = true) {
  const tmpdir = os.tmpdir();
  const suffix = serverCounter++;
  const filepath = path.join(
    tmpdir,
    `prettier-ruby-parser-${process.pid}-${suffix}.txt`
  );

  const options = {
    env: Object.assign({}, process.env, { LANG: getLang() }),
    stdio: ["ignore", "ignore", "inherit"],
    detached: true
  };

  if (opts.filepath) {
    const prettierConfig = await resolveConfigFile(opts.filepath);
    options.cwd = path.dirname(prettierConfig);
  }

  const server = spawn(
    opts.rubyExecutablePath || "ruby",
    [
      url.fileURLToPath(new URL("./server.rb", import.meta.url)),
      `--plugins=${getPlugins(opts).join(",")}`,
      filepath
    ],
    options
  );

  server.unref();

  if (killOnExit) {
    process.on("exit", () => {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }

      try {
        if (server.pid) {
          // Kill the server process if it's still running. If we're on windows
          // we're going to use the process ID number. If we're not, we're going
          // to use the negative process ID to indicate the group.
          const pid = process.platform === "win32" ? server.pid : -server.pid;
          process.kill(pid);
        }
      } catch (error) {
        // If there's an error killing the process, we're going to ignore it.
      }
    });
  }

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (fs.existsSync(filepath)) {
        const connectionJSON = fs.readFileSync(filepath).toString("utf-8");
        resolve({
          serverPID: server.pid,
          connectionFilepath: filepath,
          connectionOptions: JSON.parse(connectionJSON)
        });

        clearTimeout(timeout);
        clearInterval(interval);
      } else if (server.exitCode) {
        reject(new Error("Failed to start parse server."));
        clearTimeout(timeout);
        clearInterval(interval);
      }
    }, 100);

    const timeout = setTimeout(
      () => {
        const message =
          "Failed to get connection options from parse server in time. If this happens repeatedly, try increasing the PRETTIER_RUBY_TIMEOUT_MS environment variable beyond 10000.";

        clearInterval(interval);
        reject(new Error(message));
      },
      parseInt(process.env.PRETTIER_RUBY_TIMEOUT_MS || "10000", 10)
    );
  });
}

// Pre-configured server connection from environment (used by test suite).
const envConnectionOptions = process.env.PRETTIER_RUBY_HOST
  ? JSON.parse(process.env.PRETTIER_RUBY_HOST)
  : null;

// Map from plugin configuration key to a Promise that resolves to the
// connection options for that server. Using promises as values prevents
// duplicate spawns when concurrent parse calls share the same config.
const servers = new Map();

// Derive a stable key from the options that affect server-level behavior
// (i.e. which syntax_tree plugins are loaded). Options like printWidth and
// tabWidth are sent per-request and do not need to be part of the key.
function serverKey(opts) {
  return getPlugins(opts).sort().join(",");
}

// Formats and sends an asynchronous request to the parser server.
async function parse(parser, source, opts) {
  let connOpts;

  if (envConnectionOptions) {
    connOpts = envConnectionOptions;
  } else {
    const key = serverKey(opts);

    if (!servers.has(key)) {
      servers.set(
        key,
        spawnServer(opts).then((s) => s.connectionOptions)
      );
    }

    connOpts = await servers.get(key);
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let chunks = "";

    socket.on("error", (error) => {
      reject(error);
    });

    socket.on("data", (data) => {
      chunks += data.toString("utf-8");
    });

    socket.on("end", () => {
      const response = JSON.parse(chunks);

      if (response.error) {
        const error = new Error(response.error);
        if (response.loc) {
          error.loc = response.loc;
        }

        return reject(error);
      }

      resolve(response);
    });

    socket.connect(connOpts, () => {
      socket.end(
        JSON.stringify({
          parser,
          source,
          maxwidth: opts.printWidth,
          tabwidth: opts.tabWidth
        })
      );
    });
  });
}

// Metadata mostly pulled from linguist and rubocop:
// https://github.com/github/linguist/blob/master/lib/linguist/languages.yml
// https://github.com/rubocop/rubocop/blob/master/spec/rubocop/target_finder_spec.rb
const plugin = {
  languages: [
    {
      name: "Ruby",
      parsers: ["ruby"],
      extensions: [
        ".arb",
        ".axlsx",
        ".builder",
        ".eye",
        ".fcgi",
        ".gemfile",
        ".gemspec",
        ".god",
        ".jb",
        ".jbuilder",
        ".mspec",
        ".opal",
        ".pluginspec",
        ".podspec",
        ".rabl",
        ".rake",
        ".rb",
        ".rbi",
        ".rbuild",
        ".rbw",
        ".rbx",
        ".ru",
        ".ruby",
        ".thor",
        ".watchr"
      ],
      filenames: [
        ".irbrc",
        ".pryrc",
        ".simplecov",
        "Appraisals",
        "Berksfile",
        "Brewfile",
        "Buildfile",
        "Capfile",
        "Cheffile",
        "Dangerfile",
        "Deliverfile",
        "Fastfile",
        "Gemfile",
        "Guardfile",
        "Jarfile",
        "Mavenfile",
        "Podfile",
        "Puppetfile",
        "Rakefile",
        "Snapfile",
        "Thorfile",
        "Vagabondfile",
        "Vagrantfile",
        "buildfile"
      ],
      interpreters: ["jruby", "macruby", "rake", "rbx", "ruby"],
      linguistLanguageId: 326,
      vscodeLanguageIds: ["ruby"]
    },
    {
      name: "RBS",
      parsers: ["rbs"],
      extensions: [".rbs"]
    },
    {
      name: "HAML",
      parsers: ["haml"],
      extensions: [".haml"],
      vscodeLanguageIds: ["haml"]
    }
  ],
  parsers: {
    ruby: {
      parse(text, opts) {
        return parse("ruby", text, opts);
      },
      astFormat: "ruby",
      hasPragma(text) {
        return /^\s*#[^\S\n]*@(?:prettier|format)\s*?(?:\n|$)/m.test(text);
      },
      locStart() {
        return 0;
      },
      locEnd() {
        return 0;
      }
    },
    rbs: {
      parse(text, opts) {
        return parse("rbs", text, opts);
      },
      astFormat: "rbs",
      hasPragma(text) {
        return /^\s*#[^\S\n]*@(prettier|format)\s*(\n|$)/.test(text);
      },
      locStart() {
        return 0;
      },
      locEnd() {
        return 0;
      }
    },
    haml: {
      parse(text, opts) {
        return parse("haml", text, opts);
      },
      astFormat: "haml",
      hasPragma(text) {
        return /^\s*-#\s*@(prettier|format)/.test(text);
      },
      locStart() {
        return 0;
      },
      locEnd() {
        return 0;
      }
    }
  },
  printers: {
    ruby: {
      print(path) {
        return path.getValue();
      },
      insertPragma(text) {
        return `# @format${text.startsWith("#") ? "\n" : "\n\n"}${text}`;
      }
    },
    rbs: {
      print(path) {
        return path.getValue();
      },
      insertPragma(text) {
        return `# @format${text.startsWith("#") ? "\n" : "\n\n"}${text}`;
      }
    },
    haml: {
      print(path) {
        return path.getValue();
      },
      insertPragma(text) {
        return `-# @format${text.startsWith("-#") ? "\n" : "\n\n"}${text}`;
      }
    }
  },
  options: {
    rubyPlugins: {
      type: "string",
      category: "Ruby",
      default: "",
      description: "The comma-separated list of plugins to require.",
      since: "3.1.0"
    },
    rubySingleQuote: {
      type: "boolean",
      category: "Ruby",
      default: false,
      description:
        "When double quotes are not necessary for interpolation, prefers the use of single quotes for string literals.",
      since: "1.0.0"
    },
    rubyExecutablePath: {
      type: "string",
      category: "Ruby",
      default: "ruby",
      description:
        "The path to the Ruby executable to use to run the formatter.",
      since: "3.3.0"
    }
  },
  defaultOptions: {
    printWidth: 80,
    tabWidth: 2,
    trailingComma: "none",
    singleQuote: false
  }
};

export default plugin;
