import { useEffect, useState } from "react";
import {
  createSystem,
  createVirtualTypeScriptEnvironment,
  VirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import typescript from "typescript";

import { log } from "./log";
import { createFs } from "./createFs";

/** Map from fileName to fileContent */
export type FileMap = Record<string, string>;

interface ExtendedWindow extends Window {
  ts?: VirtualTypeScriptEnvironment;
}
declare const window: ExtendedWindow;

export function useTypescript(code: string, types?: FileMap) {
  const [ts, setTs] = useState<VirtualTypeScriptEnvironment>();

  useEffect(() => {
    (async () => {
      const fs = await createFs("4.3.5");
      fs.set("index.ts", code);

      const system = createSystem(fs);
      const env = createVirtualTypeScriptEnvironment(
        system,
        ["index.ts"],
        typescript,
        {
          noEmit: true,
          target: typescript.ScriptTarget.ESNext,
        }
      );
      setTs(env);

      log("Initialized");
      window.ts = ts;
    })();

    return () => {
      log("Destroying language service");
      ts?.languageService.dispose();
    };
  }, []);

  useEffect(() => {
    if (!ts || !types) {
      return;
    }

    log("Loading additional types");

    Object.entries(types).forEach(([fileName, fileContent]) => {
      ts?.createFile(fileName, fileContent);
    });
  }, [ts, types]);

  return ts;
}
