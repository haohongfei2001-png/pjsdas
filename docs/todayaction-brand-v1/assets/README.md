# A 标志工程交接资产

这些文件位于 docs 下，不被当前生产程序引用。它们是已选A的工程描摹候选，不是另一轮创意方案，也不是已验收的最终Logo。

- `approved-A-reference.webp`：owner选定原图的局部压缩预览，形状参考以此为准。原PNG校验值与裁切坐标见SOURCE.json；原PNG另随下载交接包保存。
- `a-mark-primary.svg`：透明渐变主标。
- `a-mark-small.svg`：相同几何、对比度强化的小尺寸版。
- `a-mark-mono.svg`：单色轮廓检查版。
- `a-app-master.svg`：浅底不透明1024方形母图，没有预裁圆角和画布外阴影。
- `a-app-maskable.svg`：较大安全边距的独立候选。

在本地技术预览中已检查三段形状和16/24/32/48px渲染；没有做实际浏览器安装、真实iPhone或正式商标清查。不要据此写生产PASS。

Work应在现有工程工具链中加入一个可复現导出步骤，再将确认后的文件放入public/brand。不得从宣传板整图缩出favicon，不得把半透明截图当作生产透明标志。图标和字标分开，字标必须拼写TodayAction。生产脚本应拒绝SVG外部资源、脚本和不受控字体依赖。
