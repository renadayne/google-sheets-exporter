# Test plan and requirement traceability

Status: chiến lược kiểm thử, **chưa chạy tests**. Automated mocks chứng minh logic extension, không chứng minh Google thực thi policy đúng trong tenant thật. G1/G7 phân biệt hai loại bằng chứng.

## 1. Layers và oracles

- Unit (U): URL/A1, 2D partition/coverage, normalizer, visibility, names, CSV safety, state transitions, retry/limit math. Fake clock/random để test retry/cancel không sleep thật.
- Integration (I): production adapters/controller/writers với fake HTTP/Chrome ports, sanitized Google response fixtures; schema validation; independent CSV/ZIP/XLSX readers. Không round-trip chỉ bằng chính writer rồi gọi đủ bằng chứng.
- Browser E2E (E): bundled unpacked MV3 extension, real page/worker/downloads với routed API fixtures; inspect downloaded files. Worker stop, page close, CSP, keyboard focus và endpoint allowlist.
- Real Google (R): approved synthetic workbook/account, live APIs/Chrome OAuth. Record permission/principal consistency và source semantics.
- Workspace/manual (W): admin-controlled IRM/DLP/shared drive/OAuth block. Tenant có feature licensing cần thiết; human coordinates policy changes.
- Desktop manual (M): Excel/LibreOffice mở/import artifacts; no repair, inert formula text, encoding, data types. Record exact reader version/import workflow.

Không test bằng dữ liệu customer. Fixtures expected values được viết tay hoặc generator có invariant/oracle độc lập; tránh dùng normalizer để tạo expected output của chính normalizer.

## 2. Fixture catalog

| Fixture | Nội dung | Assertion quan trọng |
|---|---|---|
| F01-basic | 3 tabs với stable IDs/order, strings/numbers/bools | Đúng số tab, đúng thứ tự và type |
| F02-sparse | A1=`00123`, D50=`middle`, Z90000=42, blank stretches | Absolute coordinates; không early stop/compact |
| F03-empty | Empty tab; empty first/middle/trailing rows; explicit empty string | Full selected bounds independent from returned data |
| F04-names | Spaces, apostrophes, emoji, long names, XLSX-invalid characters, case/suffix collisions | Deterministic safe names + original mapping |
| F05-types | Formatted currency, raw number/bool, date/time serial, timezone/locale, formula/result/error/empty formula | Projection per mode; no guessed Date/header/type |
| F06-text | Comma, quotes, CR/LF, tabs, emoji, whitespace, 00123, `=`, `+`, `-`, `@`, prefixed controls, URL-like text | Exact JSON; CSV transformation counts; no XLSX formulas/hyperlinks |
| F07-visibility | Hidden tab/row/column, filtered rows, group-hidden, personal filter view distinction | API visibility only; gaps kept; missing metadata not “visible-only” |
| F08-policy | canDownload true/false/missing, restriction field absent/conflicting, shared drive/DLP contexts | Restricted/uncertain never read cells/download |
| F09-faults | 401, admin403, unknown403, rate-limit403, 404, 408, 429 Retry-After, 503, timeout/offline | Bounded retry vs terminal; redacted errors |
| F10-races | Cancel at each await boundary; late worker response; account change; revoke before final publish | No stale completion/download |
| F11-mutation | Version/modifiedTime/grid dimensions change; volatile formula without version change | Detectable change failure; no atomic guarantee otherwise |
| F12-limits | XLSX max row/col and +1, long cell text, invalid XML controls, numeric edge, resource cap+1 | No silent truncation/coercion |
| F13-ranges | C5:D6, single cell, whole row/col, quoted title, `$A$1`, malformed union/named range | Scope/origin explicit; valid bounds and offsets |
| F14-unsupported | Non-GRID sheet, CSE/shortcut/resource-key context without verified support | Actionable unsupported; no partial hidden success |

F04/F12 có synthetic API mocks cho trạng thái khó/không thể tạo trực tiếp trên Google UI; đánh dấu synthetic, không nói Google có thể tạo mọi tên/kích thước đó. Large fixtures được generate on demand, không commit hàng triệu empty cells.

## 3. Acceptance matrix (toàn bộ AC)

| AC | Test / expected evidence | Layers | Real Workspace tenant? | Tasks |
|---|---|---|---|---|
| AC-01 | F01 -> XLSX exactly 3 worksheets ordered; independent parse + no repair | I,E,R,M | Không; ordinary test Google account đủ | T28,T31,T37,T39,T42 |
| AC-02 | F01 -> ZIP exactly 3 CSV + manifest, stable mapping/origins | I,E,R,M | Không | T26,T27,T37,T39,T42 |
| AC-03 | Schema-valid JSON, unique absolute coords, scopes/completeness metadata | U,I,E,R | Không | T09,T24,T37,T39 |
| AC-04 | F02 every mode/output; coordinate oracle including last distant cell | U,I,E,R | Không; cần synthetic large Google fixture | T03,T14,T15,T22,T28,T41 |
| AC-05 | F03 sheet retained, blank rows/gaps declared, no crash | U,I,E,R | Không | T03,T15,T24,T26,T28,T39 |
| AC-06 | F04 safe unique names and manifest; original IDs preserved | U,I,E,M | Không | T12,T25,T27,T28,T29,T42 |
| AC-07 | F06 independent parsers exact Unicode/quoting/whitespace; documented safe CSV changes | U,I,E,M | Không | T15,T26,T27,T39,T42 |
| AC-08 | F05 displayed/raw/formula modes vs known source oracle | U,I,R,M | Không; live Sheets account bắt buộc source evidence | T03,T15,T24,T28,T40,T42 |
| AC-09 | Formula-injection corpus; no XLSX formula XML, no execution supported CSV readers | U,I,E,M | Không | T04,T26,T28,T39,T42 |
| AC-10 | Viewer IRM denial; assert zero grid requests + zero download/preview, clear memory on revocation | I,E,W | **Có** cho enterprise IRM/DLP; ordinary owner restriction bổ sung | T02,T18,T22,T31,T40 |
| AC-11 | Actual OAuth app blocked/approval-required; actionable message, no fallback | I,E,W | **Có** | T05,T17,T18,T33,T40 |
| AC-12 | Two signed-in accounts, page and token differ; correct principal displayed, signout invalidates job | I,E,R | Không; 2 test accounts; tenant variant ở T40 | T05,T17,T30,T33,T38,T40 |
| AC-13 | F09 deterministic retry budget; transient recover or clean terminal; no corrupt file | U,I,E,R | Không; inject faults, không cố gây Google quota exhaustion | T19,T22,T30,T39,T41 |
| AC-14 | Permanent deny/delete during read/final check; no artifact | I,E,R,W | Có cho enterprise revocation variant; delete test không cần | T18,T22,T30,T31,T40 |
| AC-15 | F10 cancel read/backoff/serialize/pre-download; late completions ignored | U,I,E | Không | T19,T30,T31,T36,T38,T41 |
| AC-16 | F12 over XLSX dimensions/text cap -> explicit error/alternative; no truncation | U,I,E | Không; mocked impossible source extents allowed | T23,T29,T34,T39,T42 |
| AC-17 | F11 edit/resize during read -> no publish; unchanged still non-atomic disclosure | I,E,R | Không | T32,T35,T39,T40 |
| AC-18 | F07 hidden selection matches declared API semantics; unsupported visibility disabled | U,I,E,R | Không; Workspace optional extra coverage | T03,T16,T22,T34,T40 |
| AC-19 | URL gid highlights but leaves default all-visible tabs selected | U,E,R | Không | T11,T13,T33,T34,T37 |
| AC-20 | F08/F14 unverified/unsupported context -> no invented success/fallback | I,E,R,W | **Có** để cover enterprise unsupported policies | T02,T18,T33,T39,T40,T43 |

Mỗi test record cần fixture/version, expected vs actual, command/manual steps, artifact validation và pass/fail/blocked. Snapshot screenshot không thay coordinate/type oracle.

## 4. FR / NFR traceability

| Requirement | Tasks | Primary tests |
|---|---|---|
| FR-01 | T11,T13,T33,T37 | AC-19; malformed source table |
| FR-02 | T02,T05,T17,T18,T22,T30,T31,T40 | AC-10/11/12/14/20 + F10 revocation race |
| FR-03 | T03,T13,T20,T25,T34 | AC-01/02/03/05/06/18 |
| FR-04 | T03,T15,T24,T26,T28,T34 | AC-07/08/09 |
| FR-05 | T12,T13,T14,T15,T16,T22,T26,T28 | AC-04/05 + F13 offset test |
| FR-06 | T06,T12,T13,T23,T29,T34,T41 | AC-16 + F12 cap+1 + scope UI |
| FR-07 (Should) | T03,T13,T16,T22,T34,T40 | AC-18, missing visibility metadata |
| FR-08 | T04,T25,T28,T29,T31,T42 | AC-01/06/08/09/16 |
| FR-09 | T04,T25,T26,T27,T31,T42 | AC-02/06/07/09 |
| FR-10 | T08,T09,T24,T39 | AC-03/04/05/08; secret exclusion |
| FR-11 | T19,T22,T23,T30,T31,T35,T36,T38 | AC-13/14/15 + lifecycle |
| FR-12 | T03,T24,T29,T32,T35,T40 | AC-17, volatile formula disclaimer |
| FR-13 | T05,T17,T30,T31,T36,T38,T43 | no automatic extraction; local download; no secrets/storage/third party |
| NFR-01 | T07,T36,T37,T38,T44 | MV3 load/CSP + SW suspension |
| NFR-02 | T03,T12..T16,T24..T29,T39,T42 | AC-01..09, F13 coordinate oracle |
| NFR-03 | T06,T14,T23,T36,T41 | Benchmark matrix below + limit failures |
| NFR-04 | T19,T22,T30,T31,T38,T40 | AC-13/14/15 |
| NFR-05 | T02,T05,T18,T26,T28,T31,T38,T40 | AC-09/10/11/12/20, endpoint/secret audit |
| NFR-06 | T17,T30,T31,T36,T38,T43 | Storage/log/worker/network inspection |
| NFR-07 | T09,T23,T24,T29,T34,T35,T43 | scope/mode/exclusions/CSV transforms/non-atomic summaries |
| NFR-08 | T07,T08,T09,T10,T44 | module boundary/typecheck/contract review |
| NFR-09 | T33,T34,T35,T38 | Keyboard-only flow, labels/focus/live region, disabled/error semantics |
| NFR-10 | T05,T07,T10,T43,T44 | Clean checkout install/build/load/test/sample export |

Goals G-01..G-11 được bao phủ lần lượt bởi multi-tab, coordinates, formats, reports, MV3, direct API, permission gates, reliability, scope selector, visibility, JSON schema. Không có Must bị dời sang later.

## 5. Representative benchmarks

**Proposed targets, chưa đo:** Chrome stable desktop trên Windows, máy 16 GiB RAM; ghi CPU/Chrome/OS/dependency versions thực tế. Mỗi case 3 runs, báo median/max, cold/warm rõ; latency real API tách khỏi mocked serialization. Memory lấy browser process/DevTools, không hứa portable per-job heap enforcement.

| Case | Dataset | Targets / expected behavior |
|---|---|---|
| B-small | 3 tabs x 1,000 rows x 10 cols, mixed types | Local serialize <=10s; normal network full job mục tiêu <=60s |
| B-sparse | 90,000 x 26 positions, chỉ A1/D50/Z90000 có giá trị | Full coordinates; local serialize <=15s; API run <=5min trong quota bình thường; báo request count |
| B-dense | 250,000 populated mixed scalar cells, short strings | Peak incremental memory mục tiêu <=512 MiB; local serialize <=60s; job <=10min |
| B-long | Long strings tăng đến decoded byte cap | Counter stops before publish; memory measured; no browser crash; no success-looking partial |
| B-grid | Allocated positions 10M và 10M+1; ít values | At cap either pass within other budgets or explicit budget failure; cap+1 rejected before cell reads |
| B-cancel | Cancel read/backoff/worker serialization at peak | UI acknowledgement <=250ms target; abort/terminate <=2s; zero new download |
| B-limit | 250k+1 emitted cells / 64 MiB+1 decoded or uncompressed / output cap+1 | Explicit terminal error, buffers cleared; no silent scope reduction |

10M positions là admission ceiling, không cam kết mọi combination dưới đó đều pass byte/time/memory limits. Streaming JSON/CSV không tự làm XLSX bounded-memory; đo từng writer và ZIP aggregate. Các limits trong A§I phải được T06/T41 cập nhật **cùng docs/UI/tests sau review**. Không gọi proposed targets là measured performance.

## 6. Authorization và race protocol

1. Admin/owner tạo synthetic files, lưu role/policy matrix bằng aliases. Không cần đọc forbidden content để chứng minh denial: assert gate decision và absence of grid requests/downloads.
2. Test unrestricted owner/editor/viewer; viewer restriction; writer restriction; shared-drive/DLP context; OAuth approval needed; missing evidence and ambiguous 403.
3. Với allowed job, revoke sau first successful chunk và trước final gate. Quan sát no subsequent publish, worker termination, private staging cleared; API-denied partial response không hiển thị preview/download.
4. Final check allowed rồi revocation xảy ra ngay sau đó là documented race; không claim instant server-side transaction. Confirmed denial trước publish luôn thắng stale success.
5. Test source disappearing/account change during retry. Không principal switch hoặc native-export fallback. Unknown result phải uncertain, không permitted vì user bấm xác nhận.

## 7. Reader và privacy protocol

XLSX: unzip kiểm worksheet count/order/coordinates, scalar types, absence of formula/externalLink nodes; đọc bằng independent parser; mở desktop reader không repair. Cell text >limit/XML controls phải error, không strip. CSV: parse independent UTF-8/BOM, quote/CRLF/embedded newlines; spreadsheet-open test dangerous corpus, transformations reported; exact alternative JSON round-trip. Multi-tab ZIP manifest chứa scope origins/name mappings; một CSV không thể tự mang mọi metadata nên UI/optional report phải đúng.

Privacy: intercept endpoints và inspect packaged code; no third-party content upload, remote code or cookies. Check local/session/IndexedDB storage, worker messages, exported report and error/log output cho token/account leaks. Closing tab does not retain resumable workbook; cleanup success/failure/signout/cancel paths đều kiểm tra. Browser OS paging/network cache không được tuyên bố secure erase.

## 8. Release exit criteria

T44 chỉ pass khi automated suite, real tenant mandatory rows, reader compatibility, calibrated benchmarks và clean-setup run có evidence. Mục manual blocked không được đổi thành pass vì mock pass. Mọi residual unsupported context phải khớp approved scope và UI. Không có requirements Must bị bỏ qua; nếu conflict chưa giải quyết, release status blocked và stakeholder quyết định thay đổi scope riêng.
