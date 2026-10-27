// CC-WIN-3: host config files written on Windows carry a UTF-8 BOM (PowerShell 5 Set-Content/Out-File
// -Encoding UTF8) and CRLF line ends. JSON.parse throws on a BOM. One shared pair of functions: read a file as
// plain LF text for parsing and editing, then give the edited text the layout the file had. Pure, no imports
// (the hook bundle loads this through user-deny.ts). No regex: char-code and split/join only.
export interface HostLayout { bom: boolean; crlf: boolean; }

const BOM_CODE = 0xfeff;
const CRLF = "\r\n";
const LF = "\n";

export function hostLayout(raw: string): HostLayout {
  return { bom: raw.length > 0 && raw.charCodeAt(0) === BOM_CODE, crlf: raw.indexOf(CRLF) >= 0 };
}

/** The file text without a leading U+FEFF, with every CRLF turned into LF. A lone CR stays. */
export function hostText(raw: string): string {
  const bare = raw.length > 0 && raw.charCodeAt(0) === BOM_CODE ? raw.slice(1) : raw;
  return bare.indexOf(CRLF) < 0 ? bare : bare.split(CRLF).join(LF);
}

/** `text` (LF, no BOM) written the way the file it replaces was: BOM kept, LF turned back into CRLF. */
export function withLayout(text: string, layout: HostLayout): string {
  const eol = layout.crlf ? text.split(LF).join(CRLF) : text;
  return layout.bom ? String.fromCharCode(BOM_CODE) + eol : eol;
}
