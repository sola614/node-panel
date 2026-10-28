# 静态演示站

把管理面板打成一份**不需要后端**的静态站，发布在 GitHub Pages：
<https://sola614.github.io/node-panel/>

思路很简单：前端所有请求都走 `core.js` 的 `api()` → 一个 `fetch` 调用。
`demo.js` 在 `core.js` 之前接管 `window.fetch`，把 `/api/*` 就地回放成录好的 JSON，
业务代码一行没改。

```
public/  ──┐
           ├─► node demo/build.js ─► dist/ ─► GitHub Pages
demo/    ──┘        │
  demo.js           ├─ 绝对路径 /style.css → 相对路径（子路径部署必需）
  api/*.json        ├─ index.html 里插入 demo.js
  build.js          └─ 拷 api/*.json
  check.js
```

## 三个关键设计

**数据是录的，不是手写的。** `demo/api/*.json` 全部来自 `PANEL_SEED_DEMO=1` 实例的真实响应。
手写假数据的话，后端一改字段名，静态站不会报错、只会某页悄悄变成「加载失败」；
录制的话数据形状天然正确。

**时间会漂移。** 录制文件里的时间戳是「录制那一刻」的，直接放半年会变成「240 天前上线」。
`demo.js` 读 `api/meta.json` 的 `recordedAt`，把所有 ISO 时间整体平移 `now - recordedAt`，
所以「刚刚」永远是刚刚。流量页的横轴日期（`YYYY-MM-DD`）单独重算。

**写操作返回成功并提示。** 静态站存不了东西，但让人走完表单、看到成功反馈，比弹「不支持」
更接近真实体验；刷新即还原也符合演示预期。

## 更新数据

后端接口改了、或想让演示数据换个样子时，重新录一遍：

```bash
# 1. 起一个带种子数据的临时实例（用临时库，别碰 data/）
PANEL_DATA_DIR=/tmp/np-demo PANEL_SEED_DEMO=1 \
  PANEL_ADMIN_PASSWORD=demo-pass-123 PORT=18080 node server.js

# 2. 录制（脚本会先「演」几条操作，好让日志页有内容）
node demo/record.js

# 3. 构建 + 自检
node demo/build.js
python3 -m http.server 8081 --directory dist &
node demo/check.js http://127.0.0.1:8081
```

`record.js` 只依赖 Node 内置 `fetch`，默认连 `http://127.0.0.1:18080`，
可以用 `DEMO_BASE` / `PANEL_ADMIN_PASSWORD` 覆盖。

录完记得把 `demo/api/*.json` 一起提交——CI 不会去起服务重录，它只负责打包。

## 本地预览

```bash
node demo/build.js
python3 -m http.server 8081 --directory dist
```

打开 <http://127.0.0.1:8081/>，密码随便填。

## 部署

`.github/workflows/pages.yml` 负责构建、自检、发布。**首次需要在仓库
Settings → Pages → Source 选 "GitHub Actions"**，之后推 `main` 就会自动更新。

自检（`check.js`）会用真 Chrome 把九个页面点一遍，卡住三件事：页面渲染出来了、
控制台没报错、没有 404。数据录坏了会在这里失败，而不是等访客看到白屏。

## 已知取舍

- **只覆盖管理台九个页面**。订阅页（`sub.html`）和邀请落地页需要带 token 访问，
  没有纳入静态站。
- **操作不会真的生效**。新建/删除都会提示「演示环境」，刷新即还原。
- **流量页的节点明细**依赖 agent 上报，种子数据里按用户可见性摊分，和真实上报的形状一致。
