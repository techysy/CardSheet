'use strict';
/**
 * 包主入口。
 *
 * 只是一层再导出：版面逻辑在 sheet.js，PDF 封装在 pdf.js，分开是为了让
 * 「像素怎么摆」和「像素怎么装进文件」互不污染。主入口把两者一起给出来，
 * 免得用 `require('@techysy/cardsheet/src/pdf')` 这种带内部路径的写法。
 */
module.exports = {
  ...require('./sheet'),
  ...require('./pdf'),
};
