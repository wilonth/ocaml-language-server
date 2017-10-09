import * as _ from "lodash";
import * as rpc from "vscode-jsonrpc";
import * as server from "vscode-languageserver";
import { merlin, parser, types } from "../../shared";
import * as command from "../command";
import * as processes from "../processes";
import Session from "./index";

export default class Analyzer implements rpc.Disposable {
  public refreshImmediate: ((event: types.TextDocumentIdentifier) => Promise<void>);
  public refreshDebounced: ((event: types.TextDocumentIdentifier) => Promise<void>) & _.Cancelable;
  private session: Session;
  private bsbDiagnostics: { [key: string]: types.Diagnostic[] };

  constructor(session: Session) {
    this.session = session;
    this.bsbDiagnostics = {};
    return this;
  }

  public clear(event: types.TextDocumentIdentifier): void {
    if (this.bsbDiagnostics[event.uri].length > 0 && this.bsbDiagnostics[event.uri][0].source !== "bucklescript") {
      this.session.connection.sendDiagnostics({
        diagnostics: [],
        uri: event.uri,
      });
    }
  }

  public dispose(): void {
    return;
  }

  public async initialize(): Promise<void> {
    this.onDidChangeConfiguration();
  }

  public onDidChangeConfiguration(): void {
    this.refreshImmediate = this.refreshWithKind(server.TextDocumentSyncKind.Full);
    this.refreshDebounced = _.debounce(
      this.refreshWithKind(server.TextDocumentSyncKind.Incremental),
      this.session.settings.reason.debounce.linter,
      { trailing: true },
    );
  }

  public refreshWithKind(syncKind: server.TextDocumentSyncKind): (id: types.TextDocumentIdentifier) => Promise<void> {
    return async (id) => {
      
      if (syncKind === server.TextDocumentSyncKind.Full) {
        const document = await command.getTextDocument(this.session, id);
        if (null != document) await this.session.merlin.sync(merlin.Sync.tell("start", "end", document.getText()), id);
      }
      const errors = await this.session.merlin.query(merlin.Query.errors(), id);
      if (errors.class !== "return") return;
      const diagnostics: types.Diagnostic[] = [];
      for (const report of errors.value) diagnostics.push(await merlin.IErrorReport.intoCode(this.session, id, report));
      this.session.connection.sendDiagnostics({ diagnostics, uri: id.uri });
    

      const bsbEnabled = this.session.settings.reason.bsb.enabled;

      // Reset state for every run. This currently can hide valid warnings in some cases
      // as they are not cached, but the alternative (trying to keep track of them) will
      // probably be worse. See https://github.com/BuckleScript/bucklescript/issues/2024
      Object.keys(this.bsbDiagnostics).forEach((fileUri) => {
        this.bsbDiagnostics[fileUri] = [];
      });
      this.bsbDiagnostics[id.uri] = [];

      if (bsbEnabled && syncKind === server.TextDocumentSyncKind.Full) {
        this.refreshDebounced.cancel();
        const bsbProcess = new processes.BuckleScript(this.session).process;
        const bsbOutput = await new Promise<string>((resolve, reject) => {
          let buffer = "";
          bsbProcess.stdout.on("error", (error: Error) => reject(error));
          bsbProcess.stdout.on("data", (data: Buffer | string) => buffer += data.toString());
          bsbProcess.stdout.on("end", () => resolve(buffer));
        });

        const diagnostics = parser.bucklescript.parseErrors(bsbOutput);
        Object.keys(diagnostics).forEach((fileUri) => {
          if (!this.bsbDiagnostics[fileUri]) { this.bsbDiagnostics[fileUri] = []; }
          this.bsbDiagnostics[fileUri] = this.bsbDiagnostics[fileUri].concat(diagnostics[fileUri]);
        });

        Object.keys(this.bsbDiagnostics).forEach((fileUri) => {
          this.session.connection.sendDiagnostics({ diagnostics: this.bsbDiagnostics[fileUri], uri: fileUri });
          if (this.bsbDiagnostics[fileUri].length === 0) { delete this.bsbDiagnostics[fileUri]; }
        });
      }
    };
  }
}
