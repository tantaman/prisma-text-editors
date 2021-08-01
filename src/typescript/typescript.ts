import {
  createSystem,
  createVirtualTypeScriptEnvironment,
  VirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import typescript from "typescript";
import { log } from "./log";
import { TSFS } from "./tsfs";

const TS_PROJECT_ENTRYPOINT = "index.ts";
export type FileMap = Record<string, string>;

/**
 * A representation of a Typescript project. Only supports single-file projects currently.
 */
export class TypescriptProject {
  private fs: TSFS;

  /**
   * Since this module is lazily initialized, this serves as a way to throttle multiple consecutive `init` requests.
   * We want to avoid initializing `tsserver` multiple times.
   *
   * After construction, it stays in the `procrastinating` state until someone requests something of it.
   * Once that happens, it goes through the `initializing` & `ready` states.
   */
  private state: "procrastinating" | "initializing" | "ready";
  /** When initialization starts, the promise it returns is stored here so that future `init` requests can be throttled */
  private initPromise?: Promise<void>;
  private tsserver?: VirtualTypeScriptEnvironment;

  constructor(entrypointFileContent: string) {
    this.fs = new TSFS();
    this.fs.fs.set(TS_PROJECT_ENTRYPOINT, entrypointFileContent);
    this.state = "procrastinating";
    this.initPromise = undefined;
  }

  get entrypoint() {
    return TS_PROJECT_ENTRYPOINT;
  }

  async init(): Promise<void> {
    this.state = "initializing";
    await this.fs.injectCoreLibs();

    const system = createSystem(this.fs.fs);
    this.tsserver = createVirtualTypeScriptEnvironment(
      system,
      [TS_PROJECT_ENTRYPOINT],
      typescript,
      {
        target: typescript.ScriptTarget.ESNext,
      }
    );

    log("Initialized");
    window.ts = this.tsserver;
    this.state = "ready";
  }

  injectTypes(types: FileMap) {
    Object.entries(types).forEach(([name, content]) => {
      if (this.tsserver) {
        log("Injecting types to tsserver");
        // if tsserver has initialized, we must add files to it, modifying the FS will do nothing
        this.tsserver.createFile(name, content);
      } else {
        log("Injecting types to fs");
        // If tsserver has not initialized yet, we can add these types to the FS directly
        this.fs.fs.set(name, content);
      }
    });
  }

  async env(): Promise<VirtualTypeScriptEnvironment> {
    // If this is the first time someone has requested something, start initialization
    if (this.state === "procrastinating") {
      this.initPromise = this.init();
      await this.initPromise;
      return this.tsserver!;
    }

    // If this is already initializing, return the initPromise so avoid double initialization
    if (this.state === "initializing") {
      await this.initPromise;
      return this.tsserver!;
    }

    // If this is ready, you're good to go
    return this.tsserver!;
  }

  async lang(): Promise<VirtualTypeScriptEnvironment["languageService"]> {
    const env = await this.env();
    return env.languageService;
  }

  destroy() {
    log("Destroying language service");
    this.tsserver?.languageService.dispose();

    log("Destroying tsserver");
    this.state = "procrastinating";
    this.initPromise = undefined;
    this.tsserver = undefined;
  }
}

interface ExtendedWindow extends Window {
  ts?: VirtualTypeScriptEnvironment;
}
declare const window: ExtendedWindow;
