declare module "tree-sitter-typescript" {
  import Parser from "tree-sitter";

  const typescript: Parser.Language;
  const tsx: Parser.Language;
  export = { typescript, tsx };
}
