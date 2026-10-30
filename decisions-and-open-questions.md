# Decisions and open questions

Hoàn tất draft: 2026-10-31 (Asia/Saigon); bắt đầu đối chiếu tài liệu ngày 2026-10-30. **Planning draft hoàn tất; implementation readiness còn conditional.** Không có live API spike hoặc tenant validation trong lượt này. Tài liệu này là decision log; agent không tự đổi các quyết định bằng code.

## Decisions đề xuất

| ID | Quyết định | Lý do / hệ quả | Status |
|---|---|---|---|
| D01 | Official OAuth + Drive gate + Sheets GridData | Public API, explicit scopes, all tabs/ranges | Proposed; G1 |
| D02 | Denied/uncertain không data download hoặc fallback | G07/FR-02 bắt buộc | Requirement constraint |
| D03 | Extension tab + worker; SW chỉ bootstrap | MV3 lifecycle, UI progress/cancel | Proposed |
| D04 | TS strict + vanilla UI + Vite | Giảm implicit framework context | Proposed |
| D05 | Full allocated grid default; 1 rectangle/tab | Không suy used range, tránh mất distant cells | Proposed |
| D06 | API-visible default khi đủ metadata; giữ gaps | Positional correctness; không claim personal filter view | Proposed; T03 |
| D07 | Sparse JSON v1 absolute zero-based half-open scopes | Stable coordinates và bounded representation | Proposed |
| D08 | Raw dates là serial + metadata; formula inert string | Không locale coercion, không execute | Proposed |
| D09 | Local ExcelJS/fflate; bounded memory | Standalone/privacy; browser streaming chưa có guarantee | Proposed; T04/T06 |
| D10 | Multi CSV ZIP; XLSX kèm metadata JSON | Mapping, đúng số sheet, exact scope | Proposed |
| D11 | No persistent datasets, no restart resume | Cleanup đơn giản; tab close phải restart | Proposed |
| D12 | Source change detected -> no artifact | Không publish mixed-source file khi đã detect | Proposed |
| D13 | Initial read-only scopes rộng thay Picker | Manual ID workflow đơn giản; cần OAuth/admin review | Proposed; T05 |
| D14 | CSV safe text prefix, exact JSON alternative | Explicit transformed values | Proposed; reader safety gate |

## Blockers và yêu cầu stakeholder quyết định

| ID | Câu hỏi / blocker | Owner / task | Default đề xuất, không phải approval đã nhận |
|---|---|---|---|
| B01 | Effective permission evidence có đủ cho IRM/DLP/shared-drive contexts mục tiêu không? | Security reviewer + admin / T02 | No live export nếu uncertain; unsupported context ghi rõ |
| B02 | Có test tenant/DLP policy và account roles để chứng minh denied cases không? | Maintainer/admin / T01,T02,T40 | Thiếu tenant -> enterprise release chưa pass |
| B03 | Internal unpacked hay public Web Store? Chấp nhận broad read-only scopes không? | Product owner / T01,T05 | Internal pilot trước; public chưa cam kết |
| B04 | OAuth principal/account display và stable extension ID được cấu hình thế nào? | Maintainer / T05 | Chrome identity; same-token account; không page cookies |
| B05 | Browser writer có pass memory/format safety/cancel không? | Reviewer / T04,T06 | Đo rồi pin limits; chưa có performance guarantee |
| Q01 | Chấp nhận visible theo API thay vì filter view đang mở? | Product owner / T01,T03 | Label rõ; nếu cần exact personal view thì blocker FR-07 |
| Q02 | Chấp nhận XLSX + companion metadata download? | Product owner / T01 | Không thêm metadata sheet; handle blocked secondary download |
| Q03 | Chấp nhận one rectangle/tab và tab cần giữ mở? | Product owner / T01 | Đủ initial Must; disjoint/resume later |
| Q04 | Full allocated-grid default và cảnh báo lớn có phù hợp UX? | Product owner / T01,T06 | Không tự chuyển used range; allow explicit A1 |
| Q05 | Numeric precision/invalid XML chars/cell text >32767 xử lý reject + JSON phù hợp không? | Product owner / T04,T29 | Không silent lossy XLSX conversion |
| Q06 | Editor vẫn được phép download trong file readers-restricted có bắt buộc v1? | Product owner/security / T02 | Uncertain đến khi chứng minh role-aware policy; potential coverage adjustment, không gọi restricted sai |

## Requirement conflicts cần công khai

- View-only với effective download/copy denial không có supported export success path. Đây là boundary đã ghi trong requirements, không phải bug sẽ bypass ở phase sau.
- Không có atomic snapshot guarantee trong multi-request Sheets acquisition. FR-12 cho phép disclosure; nếu stakeholder muốn snapshot tuyệt đối cần đổi requirement/architecture.
- Visibility semantics không đảm bảo khớp session personal filter view. Khi metadata thiếu, yêu cầu explicit include-all hoặc cancel; không claim visible-only.
- Resource bounds là operational limit có lỗi/actionable path theo FR-06, không permission để silently drop data. Nếu mọi workbook kích thước lớn phải luôn thành công thì phải thêm disk-streaming design/spike.
- Conservative permission gate có thể từ chối một số trường hợp export thật sự được phép. Chưa đạt universal authorized-case coverage; phải review B01/Q06 trước approval scope.

## Những gì đã xác minh và chưa làm

Đã đọc toàn bộ requirements, kiểm tra repo, đối chiếu official docs được dẫn trong feasibility, so sánh alternatives, định nghĩa contracts/tasks/tests. Chưa gọi Google APIs bằng account thật, chưa cài dependencies, chưa build extension, chưa chạy benchmark, chưa thử Excel/LibreOffice. Tất cả performance numbers là target đề xuất.

## Change-control cho agents

Mọi thay đổi public contract, OAuth scopes/hosts, authorization truth table, visibility semantics, output schema, resource caps phải có entry: lý do, requirement IDs, tests affected, reviewer. Task bị blocker không được thay bằng implementation “best effort” rồi mark done. Maintainer cập nhật docs trước khi giao consumer tasks tiếp theo.
