# 第三方素材声明 (Third-Party Notices)

## TWP - Translate Web Pages 图标

本扩展在 **Firefox 地址栏按钮**（manifest 中的 `page_action`）上使用了开源扩展
[TWP - Translate Web Pages](https://github.com/FilipePS/Traduzir-paginas-web)（作者 FilipePS）的图标字形与配色，
行为也与其一致：**页面未翻译时为黑白单色，翻译激活后才变为彩色**（工具栏按钮仍使用 kiss-translator 自有图标与高亮态）。

| 本扩展内文件 | 来源（上游） | 说明 |
| --- | --- | --- |
| `src/libs/pageActionIcon.js` 的 `PAGE_ACTION_SVG_XML` | `src/background/background.js` 中 `getSVGIcon()` 的 `svgXml` 字形模板 | 字形路径数据原样保留 |
| `public/images/twp-icon.svg` | 同上模板生成 | manifest 默认图标；**改动**：以 `<style>` + `@media (prefers-color-scheme: dark)` 实现亮/暗主题自适应 |
| `src/libs/pageActionIcon.js` 的配色常量 | `getSVGIcon()` 中的取值 | 未翻译 `rgb(21, 20, 26)` + 0.72 透明度 / 暗色 `rgb(251, 251, 254)`；激活 `rgb(0, 97, 224)` / 暗色 `rgb(0, 221, 255)` |

- **许可证**：Mozilla Public License 2.0（MPL-2.0），全文见本目录 `MPL-2.0.txt`
- **上游仓库**：https://github.com/FilipePS/Traduzir-paginas-web

### MPL-2.0 合规说明

- MPL-2.0 为**文件级**弱 copyleft 许可：上表素材继续以 MPL-2.0 提供，其源代码可在上游仓库获取；
  本扩展其余代码仍按仓库根目录的 `LICENSE`（GPL-3.0）授权。
- 依据 MPL-2.0 §3.3（Distribution of Larger Works），MPL 覆盖文件可与 GPL 项目组合分发，
  前提是保留 MPL 许可与版权声明、说明改动并保证 MPL 文件的源代码可得——本文件即为声明与改动说明。
- **改动说明**：字形路径未作修改；配色逻辑较 TWP 有所简化——未采用浏览器主题色
  （`themeColorFieldText` / `themeColorAttention`）与 Alpenglow 主题分支，只按 `prefers-color-scheme` 亮/暗两档取色。
- 若需要移除这些素材，删除 `public/images/twp-icon.svg` 与 `src/libs/pageActionIcon.js`，
  并将 `public/manifest.firefox.json` 中 `page_action.default_icon` 与 `src/background.js` 中
  `getPageActionIconPath` 相关调用改回 `images/logo*.png` 即可。
