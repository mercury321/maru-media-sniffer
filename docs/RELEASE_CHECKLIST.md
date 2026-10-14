# 0.2.0 发布检查清单

## 已完成

- [x] Manifest V3
- [x] 128px 商店图标
- [x] 扩展内隐私政策入口
- [x] 本地处理与不上传说明
- [x] 移除未使用的 `clipboardWrite` 和 `tabs` 权限
- [x] 商店中英文文案与权限说明
- [x] 可上传 ZIP 生成命令：`npm.cmd run release`

## 发布前由发布者完成

- [ ] 将 `docs/PRIVACY_POLICY.zh-CN.md` 发布为可公开访问的网页，并把联系邮箱替换为真实地址。
- [ ] 将公开隐私政策链接填入 Chrome Web Store Developer Dashboard。
- [ ] 录入支持邮箱与产品主页。
- [ ] 使用非敏感、可公开展示的页面制作真实截图；不要使用成人、版权不明确或包含个人信息的测试页面。
- [ ] 截图至少包括：媒体识别列表、HLS 正片下载进度、微博多清晰度合并、设置页隐私入口、工具栏红色“丸”图标与数字角标。
- [ ] 在商店的 Privacy practices 页面如实填写“网页资源和浏览活动仅在本机用于媒体发现与用户主动下载；不出售、不用于广告、不上传至开发者服务器”。
- [ ] 为每项权限粘贴 `docs/PRIVACY_POLICY.zh-CN.md` 中对应说明。
- [ ] 首次提交时选择延迟发布；审核通过后先使用 Unlisted 分发给少量测试者，再决定公开。

## 推荐的商店素材

- 商店图标：`dist/icons/maru-128.png`
- 小宣传图：运行 `npm.cmd run release` 后生成 `release/store-assets/maru-promo-440x280.png`
- 截图：1280×800 PNG，至少 1 张，推荐 4–5 张。
