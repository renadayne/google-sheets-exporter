# Feasibility assessment

Ngày đánh giá: 2026-10-30. Input: `requirements.md`. Chỉ planning, chưa viết extension hay chạy thử với Google account/Workspace tenant. Repo hiện chỉ có requirements; không tìm thấy `requirements (1).md` trên đĩa.

## 1. Kết luận và mức độ chắc chắn

**Khả thi có điều kiện** cho workbook được phép export: dùng OAuth chính thức, Drive để kiểm tra quyền, Sheets API để đọc các vùng xác định, serialize cục bộ. Chưa đủ bằng chứng để tuyên bố đã hỗ trợ mọi tổ hợp enterprise IRM/DLP. Gate G1 trong implementation plan phải pass trước khi bật acquisition production.

**Không hỗ trợ** workbook có policy cấm export, dù xem được trong browser. Không thử private RPC, DOM/canvas/clipboard/OCR, export URL khác hay account khác sau denial. Hướng dẫn người dùng xin owner/admin cấp quyền, tạo approved copy, hoặc cung cấp approved data feed ngoài workflow hiện tại.

Phân biệt:

- **Confirmed/documented:** có tài liệu chính thức cho API/field, chưa đồng nghĩa đã integration-test.
- **Assumption:** cần chứng minh bằng spike/tenant; không dùng làm product promise.
- **Recommendation:** quyết định thiết kế đề xuất, có thể sửa tại gate.
- **Open/blocker:** chưa có bằng chứng hoặc prerequisite; không cho agent tự suy đoán.

## 2. Bằng chứng và giới hạn

| Chủ đề | Fact đã đối chiếu | Hệ quả thiết kế / việc chưa xác minh |
|---|---|---|
| Quyền download | Google yêu cầu kiểm tra `capabilities.canDownload` trước download/export [S1] | Một successful Sheets read không phải proof of export permission |
| IRM/DLP | `effectiveDownloadRestrictionWithContext` tính cả file/shared-drive/DLP; legacy field không bao phủ context DLP [S2] | Không dùng riêng `copyRequiresWriterPermission`; thiếu/mâu thuẫn evidence -> uncertain |
| Full/multi-tab reads | `spreadsheets.get` hỗ trợ ranges, field masks; grid data mặc định không trả [S3] | Đọc metadata trước, grid chunks sau; không đọc viewport |
| Value modes | Values API có formatted/unformatted/formula; trailing empty rows/columns có thể bị bỏ [S4] | Đề xuất GridData cho type/error/offset rõ hơn; phải test empty semantics |
| Grid semantics | GridData có startRow/startColumn, dimension metadata có hiddenByUser/hiddenByFilter [S5]; CellData có userEntered/effective/formatted values [S6] | Coordinates tuyệt đối; API visibility không đồng nghĩa active filter view trong UI |
| Quotas | Sheets công bố 300 reads/min/project, 60/user/project; khuyến nghị payload khoảng 2 MB, timeout xử lý 180 giây [S7] | Có pacing, bounded retries, chia chunk; 2 MB không phải hard response guarantee |
| Native export | `files.export` trả bytes, giới hạn exported content 10 MB [S8] | Không chọn làm acquisition mặc định cho mọi workbook/mode |
| Chrome lifecycle | Service worker có thể dừng khi idle; globals không bền [S9] | Export chạy trong extension tab + dedicated worker, không dựa vào popup/SW sống mãi |
| Identity | Chrome identity cấp token với scopes và consent [S10] | Dùng principal của token; không suy từ account đang mở Sheets |
| OAuth scopes | Có scopes read-only; `drive.file` giới hạn file được cấp cho app [S11,S12] | Paste ID không tự grant drive.file; lựa chọn scopes cần admin/distribution review |
| XLSX | ExcelJS có browser document workbook; streaming writer không thuộc browser bundle [S13] | Memory spike là gate, không hứa browser XLSX streaming |
| ZIP | fflate hỗ trợ browser ZIP/stream APIs [S14] | ZIP vẫn chịu giới hạn Blob/buffer tổng của thiết kế này |
| Excel limits | Worksheet tối đa 1,048,576 rows, 16,384 columns; cell text 32,767 characters [S15] | Reject trước publish nếu vượt; không truncate |

## 3. Authorization decision đề xuất

Đây là **candidate process**, chưa phải khẳng định mọi tenant được bao phủ.

1. Sign-in tương tác; xác định principal từ cùng token được dùng cho Drive/Sheets. Hiện account cho user xác nhận trước job.
2. Drive `files.get` với `supportsAllDrives=true` và field mask gồm id, mimeType, capabilities.canDownload, downloadRestrictions, version, modifiedTime, trashed. Chỉ chấp nhận Google spreadsheet trực tiếp; shortcut/resource-key/CSE cases chưa xác minh -> unsupported/uncertain, không tự resolve qua đường khác.
3. `canDownload=false` -> restricted. Thiếu canDownload hoặc restriction evidence không đánh giá được -> uncertain. Bất kỳ policy denial rõ ràng nào cũng terminal.
4. Trong bản đầu đề xuất conservative gate: canDownload=true và effective restrictions được xác minh là unrestricted cho cả reader/writer. Nếu readers restricted nhưng caller có thể là editor, **không đoán role**: uncertain cho đến khi spike chứng minh cách đánh giá principal chính xác. Đây là hạn chế coverage, ghi rõ trong UI.
5. Missing restriction object không mặc định là unrestricted. Spike phải xác minh semantics field omission với field mask và tài liệu/tenant; nếu chưa xác minh thì uncertain. Account confirmation của user không thay thế policy evidence.
6. Kiểm tra trước metadata Sheets, trước mỗi batch đọc và sau serialization ngay trước download. Cùng principal/workbook/job identity xuyên suốt. Denial/uncertain/revocation -> abort, clear buffer, không tạo download/preview dữ liệu.
7. API có race giữa lần kiểm tra cuối và publish. Không thể hứa atomic authorization snapshot hoặc thu hồi file đã tải. FR-02 yêu cầu không publish **sau confirmed revocation** được đáp ứng bằng final gate và job-generation guard; nếu stakeholder đòi revocation tức thời tuyệt đối thì là blocker kiến trúc.

403 không phải lúc nào cũng policy denial: rate-limit reason đã nhận diện thì retry bounded; explicit restriction/admin block thì terminal; unknown 403 -> uncertain. 404 trình bày missing/inaccessible, không suy ra file có tồn tại. Không đổi acquisition path khi permission error.

## 4. Support classification

| Context | Phân loại đề xuất | Điều kiện / kết quả |
|---|---|---|
| Owner/editor/viewer, export allowed | Conditional supported | G1 evidence + scopes + native GRID sheet + resource budget |
| Viewer/commenter, effective IRM denied | Unsupported by design | Restricted, zero artifact |
| DLP/contextual/shared-drive policy | Gated | Tenant matrix bắt buộc; uncertain nếu không chứng minh được |
| Multiple browser accounts | Supported với token principal rõ ràng | Không tự chuyển account để retry; user chủ động sign out/sign in tạo job mới |
| OAuth blocked / admin approval | Terminal/actionable | Không gọi Sheets data endpoint |
| Public file nhưng anonymous export | Ngoài initial access path | Yêu cầu OAuth; không tận dụng public URL làm fallback |
| Special sheets: OBJECT/DATA_SOURCE, CSE | Chưa verified | Block selected unsupported sheet; user có thể chủ động bỏ chọn; không tự drop |
| Hidden dimensions | API-defined visibility có điều kiện | Không claim trùng active personal filter view |
| Large workbook vượt budget | Controlled unsupported scope | Yêu cầu explicit narrower scope/format; không âm thầm trim |

## 5. Spikes bắt buộc và evidence cần lưu

- S01 / T02: authorization matrix bằng real owner/viewer/editor + Workspace admin/DLP/shared drive. Ghi sanitized fields/status, principal alias, role/policy setup, expected/actual. Không lưu tokens hay workbook thật vào repo. Xác minh denied context không kích hoạt Sheets grid read.
- S02 / T03: GridData với 3 tabs, Unicode, offsets, A1/D50/Z90000, formula errors/empty string/date, hidden dimensions, merged cells, blank full tab. Oracle từ fixture owner tạo; metadata range không suy từ used viewport.
- S03 / T04: browser ExcelJS + fflate packaging, CSP, inert formulas, independent reader, Chrome memory/cancel/close-tab. Chọn versions sau spike và lock exact dependencies.
- S04 / T05: identity/scopes trên unpacked extension ID ổn định, Chrome profile vs Sheets account khác nhau, consent denied/revoked/admin blocked. Tối thiểu không cần client secret/back-end.
- S05 / T06: benchmark sparse/dense/long-string; output thật, byte counters, request counts, memory, elapsed. Không dùng mock latency làm chứng cứ production performance.

Chưa chạy các spike trên. Cần Google Cloud project, OAuth client/consent test users, test tenant có IRM/DLP phù hợp, Chrome và Excel/LibreOffice. Không coi thiếu tenant là pass.

## 6. Các quan sát rendering

Không xác minh canvas/virtualization bằng browser trong lượt planning này. Kiến trúc không phụ thuộc renderer hoặc DOM selectors, nên không cần dùng giả định rendering để chứng minh acquisition. Content script không cần thiết.

## 7. Nguồn chính thức

- [S1 — Drive download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [S2 — Drive content/download restrictions](https://developers.google.com/workspace/drive/api/guides/content-restrictions)
- [S3 — spreadsheets.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get)
- [S4 — Values reading](https://developers.google.com/workspace/sheets/api/guides/values)
- [S5 — Sheets/GridData/dimensions](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets)
- [S6 — CellData](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/cells)
- [S7 — Sheets usage limits](https://developers.google.com/workspace/sheets/api/limits)
- [S8 — files.export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)
- [S9 — MV3 lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [S10 — Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [S11 — Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes)
- [S12 — Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [S13 — ExcelJS upstream](https://github.com/exceljs/exceljs#browser)
- [S14 — fflate upstream](https://github.com/101arrowz/fflate)
- [S15 — Excel specifications](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits)
