import * as server from "vscode-languageserver";
import { merlin, types } from "../../shared";
import Session from "../session";

export default function(session: Session): server.RequestHandler<server.TextDocumentPositionParams, types.Definition, void> {
  return async (event, token) => {
    const find = async (kind: "ml" | "mli"): Promise<null | types.Location> => { // tslint:disable-line arrow-parens
      const request = merlin.Query.locate(null, kind).at(merlin.Position.fromCode(event.position));
      const response = await session.merlin.query(request, event.textDocument);
      if (response.class !== "return" || response.value.pos == null) return null;
      const value = response.value;
      const uri = value.file ? `file://${value.file}` : event.textDocument.uri;
      const position = merlin.Position.intoCode(value.pos);
      const range = types.Range.create(position, position);
      const location = types.Location.create(uri, range);
      return location;
    };
    const locML = await find("ml");
    if (token.isCancellationRequested) return [];
    // const locMLI = await find("mli"");
    const locations: types.Location[] = [];
    if (locML != null) locations.push(locML);
    // if (locMLI != null) locations.push(locMLI);
    return locations;
  };
}
