# Implementation plan

Đọc nhanh: feasibility -> architecture -> decisions -> tài liệu này -> chọn đúng task trong tasks.md. Đây là planning handoff, không phải xác nhận production readiness. Không có extension code được tạo ở lượt này.

## 1. Phạm vi release

Internal vertical slice là mốc kỹ thuật, **không** được gọi MVP đáp ứng requirements. Release v1 phải có mọi Must FR-01..FR-06, FR-08..FR-13 và AC tương ứng. FR-07 hidden semantics cũng nằm trong kế hoạch v1 theo API visibility. FR-09/10/11 không cắt khỏi MVP vì khó.

Later: disjoint multi-ranges/tab, saved preferences, disk streaming/OPFS, resume sau restart, richer styling, Picker/drive.file flow, alternative feed adapter, thêm browsers. Những thứ này không được dùng để trì hoãn Must ở v1. Các unsupported permission contexts và format/resource failures phải hiển thị trung thực ngay v1.

## 2. Gates và sequence

| Stage | Tasks | Exit criteria | Nếu fail |
|---|---|---|---|
| G0: review planning | T01 | Reviewer xác nhận scope/semantics, ghi owner blocker | Chỉnh docs, chưa implementation |
| G1: evidence & feasibility | T02-T06 | Auth matrix; account scope; sparse/hidden fixture; browser library; benchmark evidence được review | Không mở live acquisition; ghi unsupported hoặc proposal thay đổi requirement |
| G2: foundation/contracts | T07-T10 | Build skeleton/CSP; typed contracts/schema/fixtures freeze | Dừng consumer tasks nếu schema chưa thống nhất |
| G3: pure correctness | T11-T16 | URL/range/scope/normalizer/visibility/coverage tests pass | Không nối network vào writers |
| G4: authorized acquisition | T17-T23 | Same-principal gate, retry/cancel, metadata/chunk adapter/size guards; denied tests zero data reads | Không tiếp tục publish path |
| G5: serializers | T24-T29 | JSON/CSV/ZIP/XLSX independent round-trip + safety; deterministic report mapping | Format không pass vẫn chặn release v1 |
| G6: orchestration/UI | T30-T38 | Full state machine, final gate, cancellation races, source consistency, keyboard UI, real downloads | Không coi generated Blob là completed |
| G7: verification/release | T39-T44 | AC-01..20 evidence; real tenant cases pass; perf budgets calibrated; clean checkout guide | Giữ release blocked, không mark skipped manual test là pass |

T02-T06 là technical spikes được thực hiện **sau** review planning, trong sandbox fixture tooling; không tự biến spike thành production code. Trong lượt này chưa có credentials/tenant nên gate G1 chưa pass. Có thể làm G2/pure fixture tasks trước khi G1 hoàn tất nếu reviewer cho phép, nhưng không có live path được bật và không claim implementation ready.

## 3. Operational prerequisites

| Cần có | Người phụ trách đề xuất | Dùng ở đâu |
|---|---|---|
| Google Cloud project, bật Sheets/Drive APIs, OAuth consent, Chrome extension client ID gắn stable extension ID | Maintainer | T05, T17, manual release |
| Test users, owner/editor/viewer accounts; account aliases thay email trong evidence | Maintainer | T02, T05, T40 |
| Workspace test tenant/admin có IRM, shared drive, DLP/context controls | Admin | G1/T02 và G7/T40; nếu không có thì enterprise coverage chưa verified |
| Quyết định internal-only hay public Web Store, OAuth verification/admin policy requirements | Product owner | T01/T05/T44; không hứa public release không cần review |
| Chrome desktop, Excel hoặc LibreOffice; independent XLSX parser | QA | T04/T42 |
| Node/npm/runtime versions, lockfile và CI runner được pin | Maintainer | T07; kiểm installed versions rồi ghi README |

Không commit token, OAuth secret, cookie, customer sheet data. Public client ID là config không phải secret nhưng không hard-code private environment vào fixture. Không cần backend client secret cho kiến trúc đề xuất.

## 4. Cách điều phối agents model yếu

1. Một agent một task một lượt; không giao “implement phase 3”. Không cần agent đọc cả requirements/6 docs mỗi lần.
2. Coordinator tạo prompt bằng mẫu trong tasks.md, trích đúng sections liên quan và predecessor contracts. Budget mục tiêu: 2-4 files logic + tests, một behavior, khoảng 60-120 phút; đây là sizing heuristic, không cam kết thời gian.
3. Architecture/security spikes T02/T05 và final policy review cần reviewer đủ năng lực hoặc người có tenant access. Không yêu cầu model yếu tự giải thích DLP hoặc đổi scopes.
4. Nếu task phải thay contract hay sửa >5 production files, dừng phần đó và ghi change request. Coordinator tách task phụ theo cùng ID `.a/.b`; không cho agent tự mở rộng scope.
5. Chỉ chạy task độc lập khi dependencies đã pass. Có thể phân công đồng thời trong tương lai: T11/T12/T24 sau contracts; T25/T28 sau names+contracts. Không hai agent sửa contracts/controller/manifest cùng lúc.
6. Review output theo acceptance assertions, không chỉ “tests green”. Security/fidelity assertions phải do fixture oracle xác định, không chỉ test lại implementation.
7. Mỗi handoff lưu status, files changed, commands/results, limitations, next task vào `docs/handoffs/Txx.md`. Failed/blocked có evidence; không mark done nếu test chưa chạy.

## 5. Dependency đường găng

```text
T01 -> [T02 T03 T04 T05 T06] -> T07 -> T08 -> T09/T10
T08 -> T11/T12 -> T13 -> T14
T03/T08/T10 -> T15/T16
T05/T07/T08 -> T17 -> T18
T08/T10 -> T19; T18/T19 -> T20 -> T21
T14/T15/T16/T18/T19/T21 -> T22 -> T23
T08/T09 -> T24; T08 -> T25 -> T26 -> T27
T04/T15/T25 -> T28 -> T29
T22/T23/T24/T27/T29 -> T30 -> T31 -> T32
T17/T20 -> T33 -> T34; T30 -> T35
T24/T27/T29/T30 -> T36; T31/T32/T34/T35/T36 -> T37 -> T38
T38 -> T39/T40/T41/T42/T43 -> T44
```

Bảng mỗi task là authoritative nếu diagram rút gọn thiếu test/fixture dependency. Không schedule task bằng thứ tự số đơn thuần.

## 6. Risks và phương án khi gate fail

| Risk | Trigger / detection | Response |
|---|---|---|
| canDownload/restriction evidence không đủ cho tenant | T02 không phân loại được | Fail uncertain; xin scope review; không dùng Sheets successful read làm evidence |
| Broad read-only scopes không được admin chấp thuận | T05/tenant denial | Báo admin approval; xem xét Picker flow bằng ADR riêng, không silent switch |
| ExcelJS memory blow-up | T04/T06/T41 | Giảm documented limits với stakeholder review hoặc đổi writer sau spike; không silent truncation |
| Sparse allocated grid tạo nhiều requests | T14/T41 | Estimate theo full grid + quota; explicit scope narrowing; không stop ở blank rows |
| Active filter view không có API equivalent | T03 | API-visible label hoặc disable visible-only; không nói trùng UI |
| Closed/discarded tab | T38 | Interrupted, restart explicit, discard partial |
| Mid-job permission change / stale worker completion | T30/T31/T40 | Generation guard + final gate + clear memory; no artifact |
| Source mutation không có snapshot guarantee | T32/T40 | Detectable change fail; luôn report non-atomic limitation |
| CSV injection / XLSX incompatible values | T26/T29/T42 | Safe CSV transformation report; inert XLSX strings; JSON alternative; block unsafe output |

## 7. Release evidence bắt buộc

Requirements traceability trong test-plan.md không có Must bỏ trống. Gate owners ký kết quả, không chỉ checkbox do implementer tự đánh dấu. CI typecheck/unit/integration/build/E2E pass; tenant screenshots/status không có secrets; independent reader validates positions/types/no formulas; benchmark hardware/version/results có thật; README từ clean checkout dựng được unpacked extension; report scopes/limitations/cleanup đúng hành vi thực tế.
