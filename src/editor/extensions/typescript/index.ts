import {
  autocompletion,
  completeFromList,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { Diagnostic, linter, setDiagnostics } from "@codemirror/lint";
import {
  Extension,
  Facet,
  StateEffect,
  StateField,
  TransactionSpec,
} from "@codemirror/state";
import { hoverTooltip, Tooltip } from "@codemirror/tooltip";
import { EditorView } from "@codemirror/view";
import { debounce, noop, over } from "lodash-es";
import {
  DiagnosticCategory,
  displayPartsToString,
  flattenDiagnosticMessageText,
} from "typescript";
import { log } from "./log";
import { FileMap, TypescriptProject } from "./project";

export { TypescriptProject };
export type { FileMap };

/**
 * This file exports an extension that makes Typescript language services work. This includes:
 *
 * 1. A StateField, that holds an instance of a `TypescriptProject`
 * 2. A `javascript` extension, that provides syntax highlighting and other simple JS features.
 * 3. An `autocomplete` extension that provides tsserver-backed completions, powered by the `completionSource` function
 * 4. A `linter` extension that provides tsserver-backed type errors, powered by the `lintDiagnostics` function
 * 5. A `hoverTooltip` extension that provides tsserver-backed type information on hover, powered by the `hoverTooltip` function
 * 6. An `updateListener` (facet) extension, that ensures that the editor's view is kept in sync with tsserver's view of the file
 * 7. A StateEffect that lets a consumer inject custom types into the `TypescriptProject`
 * 8. A Facet that holds all registered `onChange` callbacks
 *
 * The "correct" way to read this file is from bottom to top.
 */

/**
 * An EditorState field that represents the Typescript project that is currently "open" in the EditorView
 */
const tsStateField = StateField.define<TypescriptProject>({
  create(state) {
    return new TypescriptProject(state.sliceDoc(0));
  },

  update(ts, transaction) {
    // For all transactions that run, this state field's value will only "change" if a `injectTypesEffect` StateEffect is attache to the transaction
    transaction.effects.forEach(e => {
      if (e.is(injectTypesEffect)) {
        ts.injectTypes(e.value);
      }
    });

    return ts;
  },

  compare() {
    // There must never be two instances of this state field
    return true;
  },
});

/**
 * A CompletionSource that returns completions to show at the current cursor position (via tsserver)
 */
const completionSource = async (
  ctx: CompletionContext
): Promise<CompletionResult | null> => {
  const { state, pos } = ctx;

  const ts = state.field(tsStateField);
  const completions = (await ts.lang()).getCompletionsAtPosition(
    ts.entrypoint,
    pos,
    {}
  );
  if (!completions) {
    log("Unable to get completions", { pos });
    return null;
  }

  return completeFromList(
    completions.entries.map(c => ({
      type: c.kind,
      label: c.name,
      detail: "detail",
      info: "info",
      // boost: 1 / distance(c.name, "con"),
    }))
  )(ctx);
};

/**
 * A LintSource that returns lint diagnostics across the current editor view (via tsserver)
 */
const lintDiagnostics = async (view: EditorView): Promise<Diagnostic[]> => {
  const ts = view.state.field(tsStateField);
  const diagnostics = (await ts.lang()).getSemanticDiagnostics(ts.entrypoint);

  return diagnostics
    .filter(d => d.start !== undefined && d.length !== undefined)
    .map(d => {
      let severity: "info" | "warning" | "error" = "info";
      if (d.category === DiagnosticCategory.Error) {
        severity = "error";
      } else if (d.category === DiagnosticCategory.Warning) {
        severity = "warning";
      }

      return {
        from: d.start!, // `!` is fine because of the `.filter()` before the `.map()`
        to: d.start! + d.length!, // `!` is fine because of the `.filter()` before the `.map()`
        severity,
        message: flattenDiagnosticMessageText(d.messageText, "\n", 0),
      };
    });
};

/**
 * A HoverTooltipSource that returns a Tooltip to show at a given cursor position (via tsserver)
 */
const hoverTooltipSource = async (
  view: EditorView,
  pos: number
): Promise<Tooltip | null> => {
  const ts = view.state.field(tsStateField);
  const quickInfo = (await ts.lang()).getQuickInfoAtPosition(
    ts.entrypoint,
    pos
  );
  if (!quickInfo) {
    return null;
  }

  return {
    pos,
    create() {
      const dom = document.createElement("div");
      dom.innerText = displayPartsToString(quickInfo.displayParts);
      if (quickInfo.documentation?.length)
        dom.innerText += "\n" + displayPartsToString(quickInfo.documentation);
      dom.setAttribute("class", "cm-quickinfo-tooltip");

      return {
        dom,
      };
    },
    above: false, // HACK: This makes it so lint errors show up on TOP of this, so BOTH quickInfo and lint tooltips don't show up at the same time
  };
};

/**
 * A (debounced) function that updates the view of the currently open "file" on TSServer
 */
const updateTSFileDebounced = debounce((view: EditorView) => {
  log("Commit file change");

  const ts = view.state.field(tsStateField);
  const content = view.state.sliceDoc(0);

  // Don't `await` because we do not want to block
  ts.env().then(env => env.updateFile(ts.entrypoint, content));
}, 100);

/**
 * A StateEffect that can be dispatched to forcefully re-compute lint diagnostics
 */
const injectTypesEffect = StateEffect.define<FileMap>();
export function injectTypes(types: FileMap): TransactionSpec {
  return {
    effects: [injectTypesEffect.of(types)],
  };
}

/**
 * A Facet that stores all registered `onChange` callbacks
 */
type OnCodeChange = (code: string) => void;
const OnCodeChangeFacet = Facet.define<OnCodeChange, OnCodeChange>({
  combine: input => {
    // If multiple `onCodeChange` callbacks are registered, chain them (call them one after another)
    return over(input);
  },
});

export function typescript(config: {
  code: string;
  onChange?: (code: string) => void;
}): Extension {
  return [
    tsStateField,
    OnCodeChangeFacet.of(debounce(config.onChange || noop, 300)),
    javascript({ typescript: true, jsx: false }),
    autocompletion({
      activateOnTyping: true,
      maxRenderedOptions: 50,
      override: [completionSource],
    }),
    linter(lintDiagnostics),
    hoverTooltip(hoverTooltipSource, {
      hideOnChange: true,
    }),
    EditorView.updateListener.of(({ view, docChanged }) => {
      if (docChanged) {
        // Update TSServer's view of this file
        updateTSFileDebounced(view);

        // Call the onChange callback
        const content = view.state.sliceDoc(0);
        const onChange = view.state.facet(OnCodeChangeFacet);
        onChange(content);

        // Then re-compute lint diagnostics
        lintDiagnostics(view).then(diagnostics => {
          view.dispatch(setDiagnostics(view.state, diagnostics));
        });
      }
    }),
  ];
}
