# 第三方来源与许可

## 随源码提供

| 组件 | 许可与本地声明 | 来源 |
| --- | --- | --- |
| PDF.js 6.5.438，构建标识 `0a4153349` | Apache-2.0，`Source/dist/vendor/pdfjs/LICENSE` | [Mozilla PDF.js v6.5.438](https://github.com/mozilla/pdf.js/releases/tag/v6.5.438) |
| PDF CMaps | Adobe BSD 条款，`Source/dist/vendor/pdfjs/cmaps/LICENSE` | 同一 PDF.js 发行包 |
| PDF 标准字体 · Foxit | BSD-3-Clause，`Source/dist/vendor/pdfjs/standard_fonts/LICENSE_FOXIT` | 同一 PDF.js 发行包内的 PDFium 字体声明 |
| PDF 渲染的 OpenJPEG、JBIG2、qcms、QuickJS 及封装 | 按组件保留原声明，见 `Source/dist/vendor/pdfjs/wasm/LICENSE_*` | 同一 PDF.js 发行包 |
| markdown-it 15.0.3 浏览器构建 | MIT，`Source/dist/vendor/markdown-it/LICENSE` | [markdown-it](https://github.com/markdown-it/markdown-it/tree/15.0.3) |
| Three.js r160 和 r187 | MIT，`Source/dist/ouroboros/Three-r160-LICENSE` 和 `Source/dist/wallpapers/static/three-r187/LICENSE` | [Three.js](https://github.com/mrdoob/three.js) |

Electron、electron-builder、Mozilla Readability、linkedom、mammoth、markdown-it、sanitize-html 和 turndown 由 `Source/package-lock.json` 锁定。源码仓库通过 npm 恢复这些依赖，分发构建产物时应完整保留随构建附带的许可和声明。

## 单独取得的翻译资源

| 资源 | 上游声明 |
| --- | --- |
| ECDICT | [MIT](https://github.com/skywind3000/ECDICT/blob/master/LICENSE) |
| CC-CEDICT | [CC BY-SA 4.0](https://cc-cedict.org/editor/editor.php?handler=Download) |
| Argos Translate | [引擎 MIT 或 CC0](https://github.com/argosopentech/argos-translate)，[维护者对官方模型包的许可说明](https://github.com/argosopentech/argos-translate/issues/533) |
| OPUS-MT | [英转中 Apache-2.0](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh)，[中转英 CC BY 4.0](https://huggingface.co/Helsinki-NLP/opus-mt-zh-en) |
| Hy-MT2-1.8B | [原模型 Apache-2.0](https://huggingface.co/tencent/Hy-MT2-1.8B)，实际使用的量化文件需要核实其独立来源 |

本候选不分发这些模型、词典、量化文件或翻译运行时。来自其他版本、转换者或镜像的资源以其实际文件和声明为准。
