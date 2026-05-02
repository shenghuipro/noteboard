
        const viewport = document.getElementById('viewport');
        const canvas = document.getElementById('canvas');
        const drawLayer = document.getElementById('drawLayer'); // 挂载手绘层
        const ROOT_BOARD_ID = 'main';

        // 🌟 新增：手绘引擎状态与初始化
        let isDrawingMode = false;
        let isDrawing = false;
        let currentStroke = [];
        let currentPathElement = null;
        const drawBtn = document.getElementById('drawBtn');

        let isTitleMode = false;
        const titleBtn = document.getElementById('titleBtn');

        if (titleBtn) {
            titleBtn.addEventListener('click', () => {
                isTitleMode = !isTitleMode;
                titleBtn.querySelector('.tool-icon').style.backgroundColor = isTitleMode ? 'var(--primary-blue)' : 'var(--card-bg)';
                titleBtn.querySelector('.tool-icon').style.color = isTitleMode ? '#fff' : '';
                viewport.style.cursor = isTitleMode ? 'text' : 'default';
                if (isTitleMode) {
                    clearCardSelection();
                    isDrawingMode = false;
                    if(drawBtn) {
                        drawBtn.querySelector('.tool-icon').style.backgroundColor = 'var(--card-bg)';
                        drawBtn.querySelector('.tool-icon').style.color = '';
                    }
                }
            });
        }

        if (drawBtn) {
            drawBtn.addEventListener('click', () => {
                isDrawingMode = !isDrawingMode;
                drawBtn.querySelector('.tool-icon').style.backgroundColor = isDrawingMode ? 'var(--primary-blue)' : 'var(--card-bg)';
                drawBtn.querySelector('.tool-icon').style.color = isDrawingMode ? '#fff' : '';
                viewport.style.cursor = isDrawingMode ? 'crosshair' : 'default';
                if (isDrawingMode) clearCardSelection();
            });
        }

        // 解析 perfect-freehand 坐标点为 SVG 路径格式
        function getSvgPathFromStroke(stroke) {
            if (!stroke || !stroke.length) return '';
            const d = stroke.reduce((acc, [x0, y0], i, arr) => {
                const [x1, y1] = arr[(i + 1) % arr.length];
                acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
                return acc;
            }, ['M', ...stroke[0], 'Q']);
            d.push('Z');
            return d.join(' ');
        }
        const STORAGE_KEY = 'gemeni-board-state-v1';

        // 视频播放进度同步监听 (由播放器 iframe 内脚本回传)
        window.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'GEMENI_SYNC_TIME') {
                const { bvid, time } = e.data;
                document.querySelectorAll('.caption-card').forEach(card => {
                    const input = card.querySelector('.caption-header-input input');
                    // 兼容处理：检查 input 里的 BV 号是否匹配当前播放的视频（支持带 _p 的分P匹配）
                    if (input && (input.value.includes(bvid) || bvid.includes(input.value.split('/').pop().split('?')[0]))) {
                        const list = card.querySelector('.caption-list');
                        const items = list.querySelectorAll('.caption-item');
                        let targetItem = null;

                        for (let i = 0; i < items.length; i++) {
                            const timeStr = items[i].querySelector('.caption-time').innerText;
                            const parts = timeStr.split(':').reverse();
                            let itemSec = 0;
                            for (let j = 0; j < parts.length; j++) itemSec += parseInt(parts[j]) * Math.pow(60, j);

                            if (itemSec <= time + 0.2) {
                                targetItem = items[i];
                            } else { break; }
                        }

                        if (targetItem && !targetItem.classList.contains('active-caption')) {
                            list.querySelectorAll('.active-caption').forEach(el => el.classList.remove('active-caption'));
                            targetItem.classList.add('active-caption');

                            // 只有在弹窗未关闭且高亮行不在视野内时滚动
                            const listRect = list.getBoundingClientRect();
                            const itemRect = targetItem.getBoundingClientRect();
                            if (itemRect.top < listRect.top + 20 || itemRect.bottom > listRect.bottom - 20) {
                                targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        }
                    }
                });
            }
        }); // 🌟 关键修复点：补全这个闭合括号，让后续脚本得以运行

        let isRestoringState = false;
        let saveStateTimer = null;
        let lastRestoreTime = 0; // 核心修复：记录撤销发生的时间，用于阻断冗余保存

        // --- 核心新增：撤销/重做 (Undo/Redo) 引擎 ---
        let undoStack = [];
        let redoStack = [];
        let currentStateStr = null;
        const MAX_HISTORY = 50; // 最多保存 50 步操作
        let isUndoRedoing = false; // 防止撤销过程中触发循环保存

        function performUndo() {
            if (undoStack.length === 0) return;
            isUndoRedoing = true;
            redoStack.push(currentStateStr);
            currentStateStr = undoStack.pop();
            localStorage.setItem(STORAGE_KEY, currentStateStr);
            restoreWorkspaceState();
            isUndoRedoing = false;
        }

        function performRedo() {
            if (redoStack.length === 0) return;
            isUndoRedoing = true;
            undoStack.push(currentStateStr);
            currentStateStr = redoStack.pop();
            localStorage.setItem(STORAGE_KEY, currentStateStr);
            restoreWorkspaceState();
            isUndoRedoing = false;
        }
        // ----------------------------------------
        //NOTE顶部工具栏 👇
        const noteToolbar = document.getElementById('noteToolbar');
        const newNoteBtn = document.getElementById('newNoteBtn');
        const noteBgColorInput = document.getElementById('noteBgColor');
        const noteAccentButtons = Array.from(document.querySelectorAll('[data-note-accent]'));
        const noteCommandButtons = Array.from(document.querySelectorAll('[data-note-command]'));
        // note顶部工具栏 👆
        let noteDefaults = {
            accentColor: noteAccentButtons[0]?.dataset.noteAccent || '#f59e0b',
            backgroundColor: noteBgColorInput?.value || '#ffffff'
        };
        if (window.marked?.setOptions) {
            window.marked.setOptions({
                gfm: true,
                breaks: true
            });
        }
        if (window.marked?.use) {
            window.marked.use({ gfm: true, breaks: true });
        }

        // ================= 1. 全局状态与地图引擎 =================
        let boardStack = [ROOT_BOARD_ID];
        function getActiveBoard() { return boardStack[boardStack.length - 1]; }

        let panX = 0, panY = 0, scale = 1;
        let isPanningCanvas = false, panStartX = 0, panStartY = 0;

        // 核心新增：无损混合 Markdown 导出引擎
        async function exportToMarkdown() {
            // 1. 强制保存一次最新状态
            saveWorkspaceState();
            const stateStr = localStorage.getItem(STORAGE_KEY);
            if (!stateStr) return alert("白板为空，无可导出内容！");

            let mdContent = "# 视觉白板导出备份\n\n> 导出时间：" + new Date().toLocaleString() + "\n\n---\n\n";

            // 2. 提取人类可读的纯文本内容 (遍历根节点卡片)
            const cards = getRootCardsForPersistence();
            cards.forEach(card => {
                const type = card.dataset.type;
                if (type === 'note') {
                    const md = card.dataset.markdown || deriveMarkdownFromHtml(card.querySelector('.md-editor').innerHTML);
                    if (md) mdContent += md + "\n\n";
                } else if (type === 'todo') {
                    mdContent += "### 待办事项\n";
                    card.querySelectorAll('.todo-item').forEach(item => {
                        const isDone = item.classList.contains('done');
                        const text = item.querySelector('.todo-text').innerText;
                        mdContent += `- [${isDone ? 'x' : ' '}] ${text}\n`;
                    });
                    mdContent += "\n";
                } else if (type === 'board' || type === 'column') {
                const title = card.querySelector(type === 'board' ? '.board-title' : '.column-title').innerText;
                mdContent += `### 📁 ${title}\n\n`;
            } else if (type === 'link') {
                const url = card.querySelector('.link-input').value;
                const clip = getLinkClipData(card);
                if (clip?.contentHtml) {
                    const tmp = document.createElement('div');
                    tmp.innerHTML = clip.contentHtml;
                    const articleText = (tmp.innerText || tmp.textContent || '').trim();
                    mdContent += `### ${clip.title || url}\n\n`;
                    if (url) mdContent += `> 来源：[${url}](${url})\n\n`;
                    if (clip.excerpt) mdContent += `> ${clip.excerpt}\n\n`;
                    if (articleText) mdContent += `${articleText}\n\n`;
                } else if (url) mdContent += `🔗 链接：[${url}](${url})\n\n`;
            } else if (type === 'image') {
                // 核心新增：将白板内的图片转为 Markdown 原生图片语法
                const imgSrc = card.querySelector('img').src;
                mdContent += `![白板图片](${imgSrc})\n\n`;
            } else if (type === 'file') {
                // 核心新增：将白板内的附件转为文本提示
                const filename = card.dataset.filename;
                mdContent += `📎 附件/文档：${filename}\n\n`;
            }
        });

            // 3. 🌟 终极压缩黑科技：Excalidraw 同款原生 GZIP 压缩引擎
            let encodedState = '';
            let isV2 = true;
            try {
                // 使用浏览器原生的 CompressionStream 将几十 MB 的 JSON 极限压缩，体积直接缩小 80% ~ 90%！
                const jsonBlob = new Blob([stateStr], { type: 'application/json' });
                const compressedStream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
                const compressedBlob = await new Response(compressedStream).blob();
                const base64data = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.readAsDataURL(compressedBlob);
                });
                // 高性能切片循环：彻底杜绝正则导致的内存溢出
                for (let i = 0; i < base64data.length; i += 100) {
                    encodedState += base64data.substring(i, i + 100) + '\n';
                }
            } catch (err) {
                console.warn("当前浏览器不支持 GZIP 压缩，退回基础编码", err);
                isV2 = false;
                const rawEncodedState = btoa(unescape(encodeURIComponent(stateStr)));
                for (let i = 0; i < rawEncodedState.length; i += 100) {
                    encodedState += rawEncodedState.substring(i, i + 100) + '\n';
                }
            }

            // 核心视觉优化：原生代码块 + 标题折叠，打上 V2 压缩版本专属标记
            const tagVer = isV2 ? '_V2' : '';
            const commentStart = '<' + `!-- GEMENI_BOARD_STATE${tagVer}_START --` + '>';
            const commentEnd = '<' + `!-- GEMENI_BOARD_STATE${tagVer}_END --` + '>';

            mdContent += `\n\n---\n\n## ⚙️ 白板底层恢复数据\n\n`;
            mdContent += `${commentStart}\n`;
            mdContent += `\`\`\`board-data\n`;
            mdContent += `${encodedState}\n`;
            mdContent += `\`\`\`\n`;
            mdContent += `${commentEnd}\n`;

            // 4. 核心升级：调用系统原生文件 API 直接写入磁盘，伪装成本地保存，大幅降低 Windows 拦截率！
            const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
            try {
                if (window.showSaveFilePicker) {
                    // 现代浏览器：弹出原生保存对话框，直接获取本地文件写入权限
                    const fileHandle = await window.showSaveFilePicker({
                        suggestedName: `白板备份_${new Date().toISOString().slice(0,10)}.md`,
                        types: [{ description: 'Markdown 文档', accept: { 'text/markdown': ['.md'] } }]
                    });
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                } else {
                    // 兼容旧版浏览器的备用方案
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `白板备份_${new Date().toISOString().slice(0,10)}.md`;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                }
            } catch (error) {
                if (error.name !== 'AbortError') console.error('保存文件失败:', error);
            }
        }

        const exportMdMenuBtn = document.getElementById('exportMdMenuBtn');
        if (exportMdMenuBtn) exportMdMenuBtn.addEventListener('click', () => { exportToMarkdown(); document.getElementById('settingsPopover').classList.remove('show'); });

        // 核心新增：智能 Markdown 解析与恢复引擎
        const importMdMenuBtn = document.getElementById('importMdMenuBtn');
        const mdFileInput = document.getElementById('mdFileInput');

        if (importMdMenuBtn && mdFileInput) {
            importMdMenuBtn.addEventListener('click', () => { mdFileInput.click(); document.getElementById('settingsPopover').classList.remove('show'); });

            mdFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                // 🌟 变更为 async 异步函数，以支持系统级的数据流解压
                reader.onload = async (event) => {
                    const text = event.target.result;

                    // 1. 兼容性探测：同时探测 V2(极限压缩版) 和 V1(原始版) 引擎数据
                    const matchV2 = text.match(/GEMENI_BOARD_STATE_V2_START([\s\S]*?)GEMENI_BOARD_STATE_V2_END/);
                    const matchV1 = text.match(/GEMENI_BOARD_STATE_START([\s\S]*?)GEMENI_BOARD_STATE_END/);

                    if (matchV2 && matchV2[1]) {
                        // 【模式 A+】：V2 引擎调用 GZIP 无损解压恢复
                        try {
                            const cleanBase64 = matchV2[1].replace(/-->/g, '').replace(/```board-data/g, '').replace(/```/g, '').replace(/\s+/g, '');
                            const binaryString = atob(cleanBase64);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

                            const blob = new Blob([bytes]);
                            const decompressedStream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
                            const decodedState = await new Response(decompressedStream).text();

                            localStorage.setItem(STORAGE_KEY, decodedState);
                            if (restoreWorkspaceState()) alert("🎉 完美恢复！V2极速压缩引擎解压完成。");
                        } catch (err) {
                            alert("备份数据损坏或浏览器版本过低不支持解压！");
                            console.error(err);
                        }
                    } else if (matchV1 && matchV1[1]) {
                        // 【模式 A】：V1 原生版向下兼容恢复
                        try {
                            const cleanBase64 = matchV1[1].replace(/-->/g, '').replace(/```board-data/g, '').replace(/```/g, '').replace(/\s+/g, '');
                            const decodedState = decodeURIComponent(escape(atob(cleanBase64)));
                            localStorage.setItem(STORAGE_KEY, decodedState);
                            if (restoreWorkspaceState()) alert("🎉 完美恢复！V1引擎读取完成。");
                        } catch (err) {
                            alert("备份数据似乎已损坏！");
                        }
                    } else {
                        // 【模式 B】：将纯文本 Markdown 直接生成一张自适应宽度的完整笔记卡片
                        const html = renderMarkdownToHtml(text);
                        const rect = viewport.getBoundingClientRect();
                        const cx = (rect.width / 2 - panX) / scale;
                        const cy = (rect.height / 2 - panY) / scale;
                        // 智能计算宽度：内容极多时给 800px 宽，避免卡片变得极其细长导致无法拖拽右下角
                        const cardW = text.length > 2000 ? 800 : (text.length > 800 ? 600 : 400);
                        const card = createNoteCard(cx - cardW / 2, cy - 150, html, cardW, 300);
                        if (card) {
                            clearCardSelection(); card.classList.add('selected');
                            updateMinimap(); scheduleSaveState();
                            alert("🎉 已作为完整笔记导入画布！");
                        }
                    }
                };
                reader.readAsText(file);
                e.target.value = ''; // 允许重复导入
            });
        }

        // 🌟 终极防弹版：Markdown 转 Column 看板解析引擎
        function parsePlainMarkdownToCards(mdText) {
            const rect = viewport.getBoundingClientRect();
            // 让生成位置始终在屏幕正中央
            let startX = (rect.width / 2 - panX) / scale - 300;
            let startY = (rect.height / 2 - panY) / scale - 200;

            // 1. 智能嗅探：寻找最适合作为 Column 标题的 heading 级别
            let splitLevel = 2;
            const h1Count = (mdText.match(/^#\s/gm) || []).length;
            const h2Count = (mdText.match(/^##\s/gm) || []).length;
            const h3Count = (mdText.match(/^###\s/gm) || []).length;

            // 核心修复：选取出现次数大于等于2的最高层级，防止把文章总标题当成了唯一分列点
            if (h2Count >= 2) splitLevel = 2;
            else if (h1Count >= 2) splitLevel = 1;
            else if (h3Count >= 2) splitLevel = 3;

            // 核心修复：使用精准级数进行切分（去掉 {1,X}），保证同级块能被正确切成多个 Column
            const splitRegex = new RegExp(`(?=^#{${splitLevel}}\\s)`, 'm');
            const sections = mdText.split(splitRegex).filter(s => s.trim().length > 0);

            const newCards = [];
            let currentX = startX;

            // 🌟 核心修复：确保每一块内容都能独立成列，并且横向间距拉开
            sections.forEach((section, idx) => {
                const headerRegex = new RegExp(`^#{${splitLevel}}\\s+(.*)`);
                const headerMatch = section.match(headerRegex);
                const columnTitle = headerMatch ? headerMatch[1].trim() : (idx === 0 ? "概览" : "延伸内容");

                const remainingContent = section.replace(headerRegex, "").trim();
                if (!remainingContent && !headerMatch) return;

        // 物理坐标：currentX 会随着循环不断增加，确保 Column 是横向并排的
        const colCard = createColumnCard(currentX, startY, columnTitle, 400, 600, "");
        const dropZone = colCard.querySelector('.column-drop-zone');

        // 修复：补全 subChunks 的变量定义与拆分逻辑
        const subChunks = remainingContent ? remainingContent.split(/\n\n(?=- \[[ xX]\])/) : [];
        subChunks.forEach(chunk => {
            let childCard = null;
                    if (chunk.match(/^- \[([ xX])\]/m)) {
                        let itemsHtml = "";
                        chunk.split('\n').forEach(line => {
                            const m = line.match(/^- \[([ xX])\] (.*)/);
                            if (m) {
                                const checked = m[1].toLowerCase() === 'x' ? 'checked' : '';
                                itemsHtml += `<div class="todo-item ${checked ? 'done' : ''}"><input type="checkbox" class="todo-checkbox" ${checked}><div class="todo-text">${escapeHtml(m[2])}</div></div>`;
                            }
                        });
                        if (itemsHtml) childCard = createTodoCard(0, 0, itemsHtml, 0, 0, true);
                    } else {
                        const html = renderMarkdownToHtml(chunk);
                        childCard = createNoteCard(0, 0, html, 0, 0, true);
                    }

                    // 物理强行塞入收纳列，并打上钢钉防重叠
                    if (childCard) {
                        dropZone.appendChild(childCard);
                        // 强制物理覆盖样式，杜绝任何外部 CSS 干扰导致的重叠！
                        childCard.style.position = 'relative';
                        childCard.style.left = 'auto';
                        childCard.style.top = 'auto';
                        childCard.style.width = '100%';
                        childCard.style.marginBottom = '12px';
                    }
                });

                newCards.push(colCard.id);
                currentX += 380; // 🌟 增加间距，确保完全不重叠
            });

            // 3. 扫尾与视角刷新
            setTimeout(() => {
                clearCardSelection();
                newCards.forEach(id => {
                    const c = document.getElementById(id);
                    if(c) c.classList.add('selected');
                });
                updateMinimap();
                scheduleSaveState();
            }, 100);
        }

        let minimapThrottleTimer = null;
        function applyTransform() {
            // 🌟 核心注入：将当前物理缩放比例暴露给 CSS，用于锚点反向补偿放大
            document.documentElement.style.setProperty('--board-scale', scale);
            // 🌟 核心提速：使用 translate3d 强制触发 GPU 渲染
            canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`;
            viewport.style.backgroundPosition = `${panX}px ${panY}px`;
            
            // 🌟 核心提速：分离地图的高频动作。让蓝框跟随鼠标实时 60fps 移动，但底层地图卡片 DOM 节流每 100ms 刷新一次
            updateMinimapViewportOnly();
            if (!minimapThrottleTimer) {
                minimapThrottleTimer = setTimeout(() => {
                    updateMinimap();
                    minimapThrottleTimer = null;
                }, 100);
            }
        }
        
        function updateMinimapViewportOnly() {
            const vpBox = document.getElementById('minimapViewport');
            if (!mmState || !vpBox || !mmState.scale) return;
            const vpX = -panX / scale, vpY = -panY / scale;
            const vpW = viewport.clientWidth / scale, vpH = viewport.clientHeight / scale;
            vpBox.style.width = (vpW * mmState.scale) + 'px'; 
            vpBox.style.height = (vpH * mmState.scale) + 'px';
            vpBox.style.left = (mmState.offsetX + (vpX - mmState.minX) * mmState.scale) + 'px'; 
            vpBox.style.top = (mmState.offsetY + (vpY - mmState.minY) * mmState.scale) + 'px';
        }

        function getCanvasCoords(e) {
            const rect = viewport.getBoundingClientRect();
            return { x: (e.clientX - rect.left - panX) / scale, y: (e.clientY - rect.top - panY) / scale };
        }

        function beginCanvasPan(e) {
            e.preventDefault();
            isPanningCanvas = true;
            viewport.classList.add('is-panning');
            panStartX = e.clientX - panX;
            panStartY = e.clientY - panY;
        }

        window.addEventListener('mousedown', (e) => {
            if (e.button !== 1 || !viewport.contains(e.target)) return;
            beginCanvasPan(e);
            e.stopPropagation();
        }, true);
        window.addEventListener('auxclick', (e) => {
            if (e.button === 1 && viewport.contains(e.target)) e.preventDefault();
        }, true);
        let isPanTicking = false;
        window.addEventListener('mousemove', (e) => { 
            if (isPanningCanvas) { 
                panX = e.clientX - panStartX; 
                panY = e.clientY - panStartY; 
                if (!isPanTicking) {
                    window.requestAnimationFrame(() => {
                        applyTransform();
                        isPanTicking = false;
                    });
                    isPanTicking = true;
                }
            }
        });
        window.addEventListener('mouseup', (e) => { if (e.button === 1) { isPanningCanvas = false; viewport.classList.remove('is-panning'); }});

        // 滚轮缩放支持
        let isWheelTicking = false;
        viewport.addEventListener('wheel', (e) => {
            if (e.target.closest('.popover-menu') ||
                e.target.closest('.trash-popover') ||
                e.target.closest('.transfer-drawer')) {
                return;
            }
            const targetCard = e.target.closest('.card');
            if (targetCard) {
                const cardRect = targetCard.getBoundingClientRect();
                const isLeftHalf = e.clientX <= cardRect.left + cardRect.width / 2;
                if (!isLeftHalf) return;
            }
            e.preventDefault();
            const zoomFactor = 0.0015;
            let delta = -e.deltaY * zoomFactor;
            let newScale = scale * (1 + delta);
            newScale = Math.max(0.1, Math.min(newScale, 5));
            const rect = viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            panX = mouseX - (mouseX - panX) * (newScale / scale);
            panY = mouseY - (mouseY - panY) * (newScale / scale);
            scale = newScale;
            
            // 🌟 核心提速：引入 requestAnimationFrame 动画帧渲染机制，防止浏览器一次性计算过载
            if (!isWheelTicking) {
                window.requestAnimationFrame(() => {
                    applyTransform();
                    isWheelTicking = false;
                });
                isWheelTicking = true;
            }
        }, { passive: false });

        let minimapUserZoom = 1;
        function zoomMinimap(factor) {
            minimapUserZoom *= factor;
            minimapUserZoom = Math.max(0.5, Math.min(minimapUserZoom, 3));
            updateMinimap();
            scheduleSaveState();
        }

        let mmState = { scale: 1, minX: 0, minY: 0, offsetX: 0, offsetY: 0 };

        function updateMinimap() {
            const mmContainer = document.getElementById('minimap');
            const mmCards = document.getElementById('minimapCards');
            const vpBox = document.getElementById('minimapViewport');
            const mmW = mmContainer.clientWidth, mmH = mmContainer.clientHeight;
            const vpX = -panX / scale, vpY = -panY / scale;
            const vpW = viewport.clientWidth / scale, vpH = viewport.clientHeight / scale;

            let minX = vpX, minY = vpY, maxX = vpX + vpW, maxY = vpY + vpH;

            const rootCards = Array.from(document.querySelectorAll('.card:not(.nested-card)')).filter(c => c.dataset.boardId === getActiveBoard());
            rootCards.forEach(c => {
                const cx = parseFloat(c.style.left), cy = parseFloat(c.style.top);
                const cw = parseFloat(c.style.width) || c.offsetWidth, ch = parseFloat(c.style.height) || c.offsetHeight;
                if(cx < minX) minX = cx; if(cy < minY) minY = cy;
                if(cx+cw > maxX) maxX = cx+cw; if(cy+ch > maxY) maxY = cy+ch;
            });

            const padding = 200; minX -= padding; minY -= padding; maxX += padding; maxY += padding;
            const worldW = maxX - minX, worldH = maxY - minY;
            const finalScale = Math.min(mmW / worldW, mmH / worldH) * minimapUserZoom;
            const offsetX = (mmW - worldW * finalScale) / 2, offsetY = (mmH - worldH * finalScale) / 2;

            mmState = { scale: finalScale, minX, minY, offsetX, offsetY };

            vpBox.style.width = (vpW * finalScale) + 'px'; vpBox.style.height = (vpH * finalScale) + 'px';
            vpBox.style.left = (offsetX + (vpX - minX) * finalScale) + 'px'; vpBox.style.top = (offsetY + (vpY - minY) * finalScale) + 'px';

            mmCards.innerHTML = '';
            rootCards.forEach(card => {
                const mc = document.createElement('div'); mc.className = 'minimap-card';
                if (card.classList.contains('selected')) mc.classList.add('selected');
                const cx = parseFloat(card.style.left), cy = parseFloat(card.style.top);
                const cw = parseFloat(card.style.width) || card.offsetWidth, ch = parseFloat(card.style.height) || card.offsetHeight;
                mc.style.width = Math.max(cw * finalScale, 2) + 'px'; mc.style.height = Math.max(ch * finalScale, 2) + 'px';
                mc.style.left = (offsetX + (cx - minX) * finalScale) + 'px'; mc.style.top = (offsetY + (cy - minY) * finalScale) + 'px';
                mmCards.appendChild(mc);
            });
        }

        const minimap = document.getElementById('minimap');
        let isDraggingMinimap = false;
        minimap.addEventListener('mousedown', (e) => { if(e.target.closest('.minimap-btn')) return; isDraggingMinimap = true; panFromMinimap(e); });
        window.addEventListener('mousemove', (e) => { if (isDraggingMinimap) panFromMinimap(e); });
        window.addEventListener('mouseup', () => { isDraggingMinimap = false; });

        function panFromMinimap(e) {
            const rect = minimap.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;
            const worldX = (clickX - mmState.offsetX) / mmState.scale + mmState.minX;
            const worldY = (clickY - mmState.offsetY) / mmState.scale + mmState.minY;
            panX = viewport.clientWidth / 2 - worldX * scale;
            panY = viewport.clientHeight / 2 - worldY * scale;
            applyTransform();
        }

        // ================= 全局拖拽与缩放状态 =================
        let isSelecting = false, hasDraggedBox = false;
        let startX, startY;
        let isDraggingCard = false;
        let hasStartedDraggingMove = false; // 核心拖拽锁：区分是点击还是真正的拖动
        let globalMouseDownX = 0, globalMouseDownY = 0;
        let isResizingCard = false; // 物理缩放引擎状态锁
        let resizeStartSize = { w: 0, h: 0 };
        let dragStartCanvasPos = {x: 0, y: 0};
        let draggedCards = [];

        function setBoardInteractionActive(active) {
            document.body.classList.toggle('board-interaction-active', !!active);
        }

        // --- 连线引擎核心状态 ---
        let lines = [];
        let isDrawingLine = false;
        let lineStartData = null; // 记录起点 { cardId, anchor }
        let tempLineElement = null; // 拖拽时的临时虚线
        let selectedLineId = null;

        // 计算连接点相对于底层 Canvas 的绝对坐标
        // 核心算法1：获取卡片四周的 4 个物理锚点
        function getCardAnchors(card) {
            const rect = card.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const x = (rect.left - canvasRect.left) / scale;
            const y = (rect.top - canvasRect.top) / scale;
            const w = rect.width / scale;
            const h = rect.height / scale;
            return {
                top: { x: x + w/2, y: y },
                bottom: { x: x + w/2, y: y + h },
                left: { x: x, y: y + h/2 },
                right: { x: x + w, y: y + h/2 }
            };
        }

        // 核心算法2：动态计算两张卡片之间的最短、最合理连接路径（防穿模）
        function getOptimalConnection(cardA, cardB) {
            const anchorsA = getCardAnchors(cardA);
            const anchorsB = getCardAnchors(cardB);
            let minDist = Infinity;
            let bestA = 'right', bestB = 'left';
            const edges = ['top', 'right', 'bottom', 'left'];

            // 遍历 16 种组合，寻找欧几里得距离最短的连线方案
            for (let a of edges) {
                for (let b of edges) {
                    const dx = anchorsA[a].x - anchorsB[b].x;
                    const dy = anchorsA[a].y - anchorsB[b].y;
                    const dist = dx*dx + dy*dy;
                    if (dist < minDist) { minDist = dist; bestA = a; bestB = b; }
                }
            }
            return { p1: anchorsA[bestA], p2: anchorsB[bestB], a1: bestA, a2: bestB };
        }

        function getBezierControlPoints(p1, p2, a1, a2) {
            const curveness = Math.max(60, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.3);
            let cp1 = { ...p1 }, cp2 = { ...p2 };
            if (a1 === 'top') cp1.y -= curveness; else if (a1 === 'bottom') cp1.y += curveness; else if (a1 === 'left') cp1.x -= curveness; else if (a1 === 'right') cp1.x += curveness;
            if (a2 === 'top') cp2.y -= curveness; else if (a2 === 'bottom') cp2.y += curveness; else if (a2 === 'left') cp2.x -= curveness; else if (a2 === 'right') cp2.x += curveness;
            return {cp1, cp2};
        }

        function getBezierPath(p1, p2, a1, a2) {
            const {cp1, cp2} = getBezierControlPoints(p1, p2, a1, a2);
            return `M ${p1.x} ${p1.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${p2.x} ${p2.y}`;
        }

        // 核心算法3：精准计算线条中点坐标，用于放置文字标签
        function getLineMidpoint(p1, p2, a1, a2, type) {
            if (type === 'straight') return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            const {cp1, cp2} = getBezierControlPoints(p1, p2, a1, a2);
            // 贝塞尔曲线 t=0.5 时的二次方程计算
            return {
                x: 0.125*p1.x + 0.375*cp1.x + 0.375*cp2.x + 0.125*p2.x,
                y: 0.125*p1.y + 0.375*cp1.y + 0.375*cp2.y + 0.125*p2.y
            };
        }

        function renderLines() {
            const linesCanvas = document.getElementById('linesCanvas');
            const labelsContainer = document.getElementById('lineLabelsContainer');
            const defs = document.getElementById('lineDefs');
            if (!linesCanvas || !labelsContainer || !defs) return;

            const temp = linesCanvas.querySelector('.temp-line');

            // 核心修复1：不能用 innerHTML = '' 粗暴清空画布，那会破坏 SVG 内部 defs 的神圣引用导致箭头失效！
            Array.from(linesCanvas.children).forEach(child => {
                if (child.tagName.toLowerCase() !== 'defs' && child !== temp) {
                    child.remove();
                }
            });

            labelsContainer.innerHTML = '';

            const currentBoard = getActiveBoard();
            const usedColors = new Set();

            lines.forEach(line => {
                const fromCard = document.getElementById(line.from);
                const toCard = document.getElementById(line.to);

                if (fromCard && toCard && fromCard.dataset.boardId === currentBoard && toCard.dataset.boardId === currentBoard && !fromCard.classList.contains('nested-card') && !toCard.classList.contains('nested-card')) {
                    const { p1, p2, a1, a2 } = getOptimalConnection(fromCard, toCard);

                    const pathType = line.type || 'bezier';
                    const color = line.color || '#a0aab8';
                    usedColors.add(color);

                    // 核心修复3：创建一个 SVG 组 (Group)，把可见线条和隐形判定区打包在一起
                    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                    g.classList.add('line-group');
                    g.dataset.lineId = line.id;

                    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    path.classList.add('visible-line');
                    const dStr = pathType === 'straight' ? `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}` : getBezierPath(p1, p2, a1, a2);
                    path.setAttribute('d', dStr);
                    path.setAttribute('stroke', color);
                    path.setAttribute('stroke-width', line.weight || 3);

                    if (line.style === 'dashed') path.setAttribute('stroke-dasharray', '8 6');
                    else if (line.style === 'dotted') path.setAttribute('stroke-dasharray', '2 6');

                    const colorId = color.replace('#', '');
                    if (line.arrow === 'forward' || line.arrow === 'both') path.setAttribute('marker-end', `url(#arrow-${colorId})`);
                    if (line.arrow === 'backward' || line.arrow === 'both') path.setAttribute('marker-start', `url(#arrow-reverse-${colorId})`);

                    if (line.id === selectedLineId) path.classList.add('selected-line');

                    // 核心修复4：创建隐形的加粗判定线，宽度达 24px，鼠标随便点都不会漏掉！
                    const hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    hitPath.classList.add('hit-path');
                    hitPath.setAttribute('d', dStr);
                    hitPath.setAttribute('stroke-width', '24');

                    g.appendChild(path);
                    g.appendChild(hitPath);
                    linesCanvas.appendChild(g);

                    // 标签处理
                    if (line.label || line.id === selectedLineId) {
                        const mid = getLineMidpoint(p1, p2, a1, a2, pathType);
                        const labelDiv = document.createElement('div');
                        labelDiv.className = 'line-label';
                        labelDiv.contentEditable = true;
                        labelDiv.dataset.lineId = line.id;
                        labelDiv.innerText = line.label || '';
                        if (!line.label && line.id !== selectedLineId) labelDiv.style.display = 'none';

                        labelDiv.style.left = mid.x + 'px'; labelDiv.style.top = mid.y + 'px';
                        labelDiv.addEventListener('mousedown', e => e.stopPropagation());
                        labelDiv.addEventListener('blur', (e) => {
                            line.label = e.target.innerText.trim();
                            renderLines(); scheduleSaveState();
                        });
                        labelsContainer.appendChild(labelDiv);
                    }
                }
            });

            // 核心修复2：必须使用原生 createElementNS 严格创建 SVG 标签并追加，这样才能被现代浏览器完美识别
            usedColors.forEach(color => {
                const colorId = color.replace('#', '');
                if (!document.getElementById(`arrow-${colorId}`)) {
                    // 生成正向箭头
                    const m1 = document.createElementNS("http://www.w3.org/2000/svg", "marker");
                    m1.id = `arrow-${colorId}`; m1.setAttribute("viewBox", "0 0 10 10");
                    m1.setAttribute("refX", "8"); m1.setAttribute("refY", "5");
                    m1.setAttribute("markerWidth", "5"); m1.setAttribute("markerHeight", "5");
                    m1.setAttribute("orient", "auto");
                    const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    p1.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); p1.setAttribute("fill", color);
                    m1.appendChild(p1); defs.appendChild(m1);

                    // 生成逆向箭头
                    const m2 = document.createElementNS("http://www.w3.org/2000/svg", "marker");
                    m2.id = `arrow-reverse-${colorId}`; m2.setAttribute("viewBox", "0 0 10 10");
                    m2.setAttribute("refX", "2"); m2.setAttribute("refY", "5");
                    m2.setAttribute("markerWidth", "5"); m2.setAttribute("markerHeight", "5");
                    m2.setAttribute("orient", "auto");
                    const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    p2.setAttribute("d", "M 10 0 L 0 5 L 10 10 z"); p2.setAttribute("fill", color);
                    m2.appendChild(p2); defs.appendChild(m2);
                }
            });
        }

        //     // 动态生成缺失的箭头标记颜色
        //     usedColors.forEach(color => {
        //         const colorId = color.replace('#', '');
        //         if (!document.getElementById(`arrow-${colorId}`)) {
        //             defs.innerHTML += `
        //                 <marker id="arrow-${colorId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        //                     <path d="M 0 0 L 10 5 L 0 10 z" fill="${color}" />
        //                 </marker>
        //                 <marker id="arrow-reverse-${colorId}" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        //                     <path d="M 10 0 L 0 5 L 10 10 z" fill="${color}" />
        //                 </marker>`;
        //         }
        //     });
        // }

        // 核心新增：悬浮连线工具栏跟随鼠标坐标弹出
        function updateLineToolbar(e = null) {
            const toolbar = document.getElementById('floatingLineToolbar');
            if (!toolbar) return;
            if (selectedLineId) {
                const line = lines.find(l => l.id === selectedLineId);
                if (!line) { toolbar.classList.remove('show'); return; }

                if (e) {
                    // 只有当鼠标点击线段的那一刻，才重新定位菜单 (鼠标上方 60px)
                    toolbar.style.left = `${e.clientX}px`;
                    toolbar.style.top = `${e.clientY - 60}px`;
                }

                toolbar.classList.add('show');
                toolbar.querySelectorAll('.line-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === (line.type || 'bezier')));
                toolbar.querySelectorAll('.line-style-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.style === (line.style || 'solid')));
                toolbar.querySelectorAll('.line-weight-btn').forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.weight) === (line.weight || 3)));
                toolbar.querySelectorAll('.line-arrow-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.arrow === (line.arrow || 'none')));

                // 核心：同步悬浮菜单里的当前选中颜色圈
                toolbar.querySelectorAll('.line-color-dot').forEach(dot => dot.classList.toggle('active', colorsEqual(dot.dataset.color, line.color || '#a0aab8')));
            } else {
                toolbar.classList.remove('show');
            }
        }

        function getCards() { return document.querySelectorAll('.card'); }

        function escapeHtml(value) {
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function escapeAttribute(value) {
            return escapeHtml(value).replace(/"/g, '&quot;');
        }

        function openExternalUrl(url) {
            const target = String(url || '').trim();
            if (!/^https?:\/\//i.test(target)) return;
            try {
                const { ipcRenderer } = require('electron');
                ipcRenderer.invoke('open-external-url', target).catch(() => window.open(target, '_blank'));
            } catch {
                window.open(target, '_blank');
            }
        }

        function getLinkClipData(card) {
            return card && card._articleClip && typeof card._articleClip === 'object' ? card._articleClip : null;
        }

        function getLinkCardLabel(card) {
            const clip = getLinkClipData(card);
            return clip?.title || card.querySelector('.link-input')?.value || '超链接';
        }

        function getLinkCardText(card) {
            const clip = getLinkClipData(card);
            const renderedText = card.querySelector('.article-clip-body')?.innerText || '';
            return [clip?.title, clip?.siteName, clip?.byline, clip?.excerpt, renderedText, card.querySelector('.link-input')?.value]
                .filter(Boolean)
                .join('\n');
        }

        function colorToHex(value) {
            if (!value) return '#ffffff';
            if (value.startsWith('#')) return value.toLowerCase();
            const rgbMatch = value.match(/\d+/g);
            if (!rgbMatch || rgbMatch.length < 3) return '#ffffff';
            return '#' + rgbMatch.slice(0, 3).map(channel => Number(channel).toString(16).padStart(2, '0')).join('');
        }

        function colorsEqual(left, right) {
            return colorToHex(left) === colorToHex(right);
        }

        function getSelectedNoteCard() {
            return document.querySelector('.note-card.selected');
        }

        function getNoteCardAppearance(card) {
            if (!card) return { ...noteDefaults };
            const computed = window.getComputedStyle(card);
            return {
                accentColor: colorToHex(card.style.getPropertyValue('--note-accent') || computed.borderTopColor || noteDefaults.accentColor),
                backgroundColor: colorToHex(card.style.getPropertyValue('--note-bg') || computed.backgroundColor || noteDefaults.backgroundColor)
            };
        }

        function applyNoteAppearance(card, accentColor = noteDefaults.accentColor, backgroundColor = noteDefaults.backgroundColor) {
            if (!card || !card.classList.contains('note-card')) return;
            card.style.setProperty('--note-accent', colorToHex(accentColor || noteDefaults.accentColor));
            card.style.setProperty('--note-bg', colorToHex(backgroundColor || noteDefaults.backgroundColor));
        }

        function updateNoteToolbar(card = getSelectedNoteCard()) {
            const toolbar = document.getElementById('noteToolbar');
            if (card) {
                if (toolbar) toolbar.style.display = 'flex';
                const appearance = getNoteCardAppearance(card);
                if (noteBgColorInput) noteBgColorInput.value = appearance.backgroundColor;
                noteAccentButtons.forEach(btn => btn.classList.toggle('active', colorsEqual(btn.dataset.noteAccent, appearance.accentColor)));
            } else {
                if (toolbar) toolbar.style.display = 'none';
            }
        }

        // 核心新增：画板专属工具栏状态管理
        function getSelectedBoardCard() {
            return document.querySelector('.board-card.selected');
        }
        function updateBoardToolbar(card = getSelectedBoardCard()) {
            const toolbar = document.getElementById('boardToolbar');
            if (card) {
                if (toolbar) toolbar.style.display = 'flex';
            } else {
                if (toolbar) toolbar.style.display = 'none';
            }
        }

        function ensureCardConnectors(card) {
            if (!card || card.querySelector('.card-connectors')) return;

            // 核心修复：如果当前卡片是 Board（画板），则直接跳过，不为其生成连线锚点
            if (card.dataset.type === 'board') return;

            const connectors = document.createElement('div');
            connectors.className = 'card-connectors';
            ['top', 'right', 'bottom', 'left'].forEach(position => {
                const dot = document.createElement('div');
                dot.className = `card-connector card-connector-${position}`;
                connectors.appendChild(dot);
            });
            card.appendChild(connectors);
        }

        function resetCardInteractiveState(card) {
            card.classList.remove('selected');
            card.classList.remove('is-editing');
            card.querySelectorAll('.md-editor, .todo-text, .column-title').forEach(editor => editor.setAttribute('contenteditable', 'false'));

            if (card.classList.contains('table-card')) {
                card.querySelectorAll('th, td').forEach(editor => editor.setAttribute('contenteditable', 'false'));
            } else if (card.classList.contains('note-card')) {
                // 核心修复：移除 Note 内部 Markdown 表格的只读属性，使其完美继承父级编辑器的状态，恢复光标和编辑能力
                card.querySelectorAll('th, td').forEach(editor => editor.removeAttribute('contenteditable'));
            }

            card.querySelectorAll('input').forEach(input => input.blur());
            const title = card.querySelector('.board-title');
            if (title) title.setAttribute('contenteditable', 'false');
        }

        function clearCardSelection() {
            getCards().forEach(card => resetCardInteractiveState(card));
            window.getSelection().removeAllRanges();
            updateNoteToolbar(null);
            updateBoardToolbar(null); // <--- 新增这行，取消选中时自动隐藏画板工具栏
            if (selectedLineId) {
                selectedLineId = null;
                renderLines();
            }
            const flt = document.getElementById('floatingLineToolbar');
            if (flt) flt.classList.remove('show');
        }

        function placeCaretAtEnd(node) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(node);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        // 核心修复：重新补回被意外删掉的函数声明
        function autoGrowNoteCard(card) {
            if (!card || !card.classList.contains('note-card')) return;
            if (card.classList.contains('nested-card')) { card.style.height = 'auto'; return; }
            const editor = card.querySelector('.md-editor');
            if (!editor) return;

            const handleHeight = card.querySelector('.note-drag-handle')?.offsetHeight || 14;
            const minCardHeight = 140;
            const html = editor.innerHTML;
            const isStructurallyEmpty = html === '' || html === '<br>' || html === '<div><br></div>' || html === '<p><br></p>';

            // 核心修复：空状态处理
            if (isStructurallyEmpty) {
                if (html !== '<div><br></div>') {
                    editor.innerHTML = '<div><br></div>';
                    if (document.activeElement === editor) placeCaretAtEnd(editor);
                }
                // 仅在非手动锁定状态下复位到最小高度
                if (card.dataset.manualHeight !== 'true') {
                    card.style.height = minCardHeight + 'px';
                }
                return;
            }

            // 计算内容所需高度
            const savedH = editor.style.height;
            editor.style.height = '0px';
            const contentH = editor.scrollHeight;
            editor.style.height = savedH;

            const neededCardHeight = Math.ceil(contentH + handleHeight);
            const currentH = parseFloat(card.style.height) || card.offsetHeight;

            // 核心逻辑：
            if (card.dataset.manualHeight === 'true') {
                if (neededCardHeight > currentH) {
                    card.style.height = `${neededCardHeight}px`;
                }
            } else {
                card.style.height = `${Math.max(minCardHeight, neededCardHeight)}px`;
            }
        }

        // 核心新增：Todo 待办事项专属高度自适应引擎
        function autoGrowTodoCard(card) {
            if (!card || !card.classList.contains('todo-card')) return;
            if (card.classList.contains('nested-card')) { card.style.height = 'auto'; return; }

            const minCardHeight = 150;
            // 记录当前高度，用于判断是否手动拉伸过
            let currentH = parseFloat(card.style.height);
            if (isNaN(currentH)) currentH = card.offsetHeight;

            // 临时释放高度约束，测量内容的自然高度
            card.style.height = 'auto';
            const naturalHeight = card.offsetHeight;

            // 如果用户手动拉伸过（manualHeight），只在内容溢出时向下撑开，否则保持手动高度
            // 如果没拉伸过，则完美贴合内容高度缩放
            if (card.dataset.manualHeight === 'true') {
                if (naturalHeight > currentH) {
                    card.style.height = `${naturalHeight}px`;
                } else {
                    card.style.height = `${currentH}px`;
                }
            } else {
                card.style.height = `${Math.max(minCardHeight, naturalHeight)}px`;
            }
        }

        function focusNoteEditor(card, placeCaret = false) {
            if (!card) return;
            clearCardSelection();
            card.classList.add('selected');
            card.classList.add('is-editing');
            const editor = card.querySelector('.md-editor');
            if (editor) {
                editor.setAttribute('contenteditable', 'true');
                editor.focus();
                if (placeCaret) placeCaretAtEnd(editor);
            }
            autoGrowNoteCard(card);
            updateNoteToolbar(card);
        }

        function selectionBelongsTo(node) {
            const selection = window.getSelection();
            if (!selection.rangeCount) return false;
            return node.contains(selection.getRangeAt(0).commonAncestorContainer);
        }

        let turndownService = null;

        function getTurndownService() {
            if (turndownService || !window.TurndownService) return turndownService;

            turndownService = new window.TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                emDelimiter: '*',
                bulletListMarker: '-'
            });

            // 🌟 核心修复：激活 GFM 表格插件！这样用户在 Note 卡片内修改表格后，底层会完美还原出 Markdown 表格语法
            if (window.turndownPluginGfm) {
                turndownService.use(window.turndownPluginGfm.tables);
            }

            turndownService.addRule('underline', {
                filter: ['u'],
                replacement(content) { return `++${content}++`; }
            });

            turndownService.addRule('highlight', {
                filter: ['mark'],
                replacement(content) { return `==${content}==`; }
            });

            turndownService.addRule('strike', {
                filter: ['del', 's', 'strike'],
                replacement(content) { return `~~${content}~~`; }
            });

                        turndownService.addRule('formula', {
                filter(node) {
                    return node.nodeName === 'SPAN' && node.classList && node.classList.contains('inline-formula');
                },
                replacement(content, node) {
                    return `$${node.getAttribute('data-formula') || content}$`;
                }
            });

            turndownService.addRule('inline-btn', {
                filter(node) { return node.nodeName === 'SPAN' && node.classList && node.classList.contains('inline-btn'); },
                replacement(content) { return `[[btn:${content}]]`; }
            });

            turndownService.addRule('inline-comment', {
                filter(node) { return node.nodeName === 'SPAN' && node.classList && node.classList.contains('inline-comment'); },
                replacement(content, node) { return `[[comment:${node.id}|${content}]]`; }
            });

            turndownService.addRule('inlineColor', {
                filter(node) {
                    return (node.nodeName === 'FONT' && node.getAttribute('color')) || 
                           (node.nodeName === 'SPAN' && node.style && node.style.color);
                },
                replacement(content, node) {
                    const color = node.getAttribute('color') || node.style.color;
                    return `[[color:${color}|${content}]]`;
                }
            });

            return turndownService;
        }

        function normalizeHtmlString(html) {
            return String(html || '')
                .replace(/\u200B/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function normalizeMarkdownSource(source) {
            return String(source || '')
                .replace(/\r\n?/g, '\n')
                .replace(/\u200B/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trimEnd();
        }

        function deriveMarkdownFromHtml(html) {
            if (!html) return '';
            const service = getTurndownService();
            if (service) return normalizeMarkdownSource(service.turndown(html));

            const temp = document.createElement('div');
            temp.innerHTML = html;
            return normalizeMarkdownSource(temp.innerText || temp.textContent || '');
        }

                function applyMarkdownExtensions(source) {
            return normalizeMarkdownSource(source)
                .replace(/```([^`\n]+)```/g, (match, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)
                .replace(/==([^=\n]+)==/g, (_, text) => `<mark>${escapeHtml(text)}</mark>`)
                .replace(/\+\+([^+\n]+)\+\+/g, (_, text) => `<u>${escapeHtml(text)}</u>`)
                .replace(/\$([^$\n]+)\$/g, (_, text) => `<span class="inline-formula" data-formula="${escapeAttribute(text)}">${escapeHtml(text)}</span>`)
                .replace(/\[\[btn:([^\]]+)\]\]/g, (_, text) => `<span class="inline-btn">${escapeHtml(text)}</span>`)
                .replace(/\[\[comment:([^|]+)\|([^\]]+)\]\]/g, (_, id, text) => `<span class="inline-comment" id="${id}" style="border-bottom: 2px dashed #f59e0b; background: rgba(245,158,11,0.1); cursor: pointer;" title="点击查看/回复评论">${escapeHtml(text)}</span>`)
                .replace(/\[\[color:([^|]+)\|([^\]]+)\]\]/g, (_, color, text) => `<span style="color: ${escapeAttribute(color)};">${text}</span>`);
        }

        function renderMarkdownToHtml(source) {
            const preparedSource = applyMarkdownExtensions(source);
            if (!preparedSource.trim()) return '';

            if (typeof window.marked !== 'undefined') {
                try {
                    const parseMarkdown = window.marked.parse || window.marked;
                    return parseMarkdown(preparedSource).trim();
                } catch (e) {
                    console.error("Markdown 解析引擎出错:", e);
                }
            }

            return preparedSource
                .split('\n\n')
                .map(block => `<p>${escapeHtml(block)}</p>`)
                .join('');
        }

        function getSelectionTextOffsetWithin(root) {
            const selection = window.getSelection();
            if (!selection.rangeCount || !selectionBelongsTo(root)) return null;

            const range = selection.getRangeAt(0).cloneRange();
            range.selectNodeContents(root);
            range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
            return range.toString().length;
        }

        function setSelectionTextOffsetWithin(root, offset) {
            if (!Number.isFinite(offset)) return;

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let currentOffset = 0;
            let targetNode = null;
            let targetOffset = 0;

            while (walker.nextNode()) {
                const textNode = walker.currentNode;
                const length = textNode.textContent.length;
                if (currentOffset + length >= offset) {
                    targetNode = textNode;
                    targetOffset = Math.max(0, offset - currentOffset);
                    break;
                }
                currentOffset += length;
            }

            const selection = window.getSelection();
            selection.removeAllRanges();

            if (!targetNode) {
                placeCaretAtEnd(root);
                return;
            }

            const range = document.createRange();
            range.setStart(targetNode, targetOffset);
            range.collapse(true);
            selection.addRange(range);
        }

        function renderNoteMarkdown(editor, options = {}) {
            const { preserveCaret = false } = options;
            const card = editor.closest('.note-card');
            if (!card) return '';

            const caretOffset = preserveCaret ? getSelectionTextOffsetWithin(editor) : null;
            const markdownSource = card.dataset.markdown !== undefined
                ? normalizeMarkdownSource(card.dataset.markdown)
                : deriveMarkdownFromHtml(editor.innerHTML);

            const html = renderMarkdownToHtml(markdownSource);
            card.dataset.markdown = markdownSource;

            if (normalizeHtmlString(editor.innerHTML) !== normalizeHtmlString(html)) {
                editor.innerHTML = html;
            }

            if (preserveCaret && caretOffset !== null) setSelectionTextOffsetWithin(editor, caretOffset);

            autoGrowNoteCard(card);
            return markdownSource;
        }

        function applyNoteCommand(command) {
            const card = getSelectedNoteCard();
            if (!card) return;
            const editor = card.querySelector('.md-editor');
            if (!editor) return;

            if (editor.getAttribute('contenteditable') !== 'true') {
                editor.setAttribute('contenteditable', 'true');
                editor.focus();
            }

            if (command === 'bold') document.execCommand('bold', false, null);
            else if (command === 'italic') document.execCommand('italic', false, null);
            else if (command === 'underline') document.execCommand('underline', false, null);
            else if (command === 'strike') document.execCommand('strikeThrough', false, null);
            else if (command === 'highlight') {
                const sel = window.getSelection();
                if (sel.rangeCount && !sel.isCollapsed) document.execCommand('insertHTML', false, `<mark>${sel.toString()}</mark>`);
            }
            else if (command === 'code') {
                 const sel = window.getSelection();
                if (sel.rangeCount && !sel.isCollapsed) document.execCommand('insertHTML', false, `<code>${sel.toString()}</code>`);
            }
            else if (command === 'formula') { const f = window.prompt('Formula', 'E = mc^2'); if (f) document.execCommand('insertHTML', false, `<span class="inline-formula" data-formula="${escapeAttribute(f)}">${escapeHtml(f)}</span>`); }
            else if (command === 'h1') document.execCommand('formatBlock', false, 'H1');
            else if (command === 'quote') document.execCommand('formatBlock', false, 'BLOCKQUOTE');
            else if (command === 'ul') document.execCommand('insertUnorderedList', false, null);
            else if (command === 'ol') document.execCommand('insertOrderedList', false, null);

            card.dataset.markdown = deriveMarkdownFromHtml(editor.innerHTML);
            autoGrowNoteCard(card);
            updateMinimap();
            scheduleSaveState();
            updateNoteToolbar(card);
        }

        function createQuickNoteAt(x, y) {
            const card = createNoteCard(x, y, '', 320, 180, false);
            requestAnimationFrame(() => focusNoteEditor(card, true));
            return card;
        }

        if (noteToolbar) {
            noteToolbar.addEventListener('mousedown', (e) => {
                if (e.target.closest('.note-toolbar-btn') || e.target.closest('.note-swatch')) e.preventDefault();
            });
        }
        if (newNoteBtn) {
            newNoteBtn.addEventListener('click', () => {
                const centerX = (-panX + viewport.clientWidth / 2) / scale;
                const centerY = (-panY + viewport.clientHeight / 2) / scale;
                createQuickNoteAt(centerX - 160, centerY - 90);
            });
        }

        noteAccentButtons.forEach(button => {
            button.addEventListener('click', () => {
                const newAccentColor = button.dataset.noteAccent;
                const selectedNote = getSelectedNoteCard();
                if (selectedNote) {
                    const appearance = getNoteCardAppearance(selectedNote);
                    // 核心修复：只将新颜色应用到当前选中的单个卡片，不再修改全局 noteDefaults
                    applyNoteAppearance(selectedNote, newAccentColor, appearance.backgroundColor);
                    updateMinimap();
                    scheduleSaveState();
                    updateNoteToolbar(selectedNote);
                }
            });
        });

        if (noteBgColorInput) {
            noteBgColorInput.addEventListener('input', () => {
                const newBgColor = noteBgColorInput.value;
                const selectedNote = getSelectedNoteCard();
                if (selectedNote) {
                    const appearance = getNoteCardAppearance(selectedNote);
                    // 核心修复：只将新颜色应用到当前选中的单个卡片，不再修改全局 noteDefaults
                    applyNoteAppearance(selectedNote, appearance.accentColor, newBgColor);
                    updateMinimap();
                    scheduleSaveState();
                    updateNoteToolbar(selectedNote);
                }
            });
        }

        if (noteBgColorInput) {
            noteBgColorInput.addEventListener('input', () => {
                noteDefaults.backgroundColor = noteBgColorInput.value;
                const selectedNote = getSelectedNoteCard();
                if (selectedNote) {
                    const appearance = getNoteCardAppearance(selectedNote);
                    applyNoteAppearance(selectedNote, appearance.accentColor, noteDefaults.backgroundColor);
                    updateMinimap();
                    scheduleSaveState();
                    updateNoteToolbar(selectedNote);
                }
            });
        }

        noteCommandButtons.forEach(button => {
            button.addEventListener('click', () => applyNoteCommand(button.dataset.noteCommand));
        });

                // 核心新增：Board 画板图标修改与图片上传核心逻辑
        const boardToolbar = document.getElementById('boardToolbar');
        if (boardToolbar) {
            boardToolbar.addEventListener('mousedown', (e) => {
                if (e.target.closest('.board-icon-btn') || e.target.closest('.note-toolbar-btn')) e.preventDefault();
            });
        }
        const boardIconBtns = document.querySelectorAll('.board-icon-btn');
        boardIconBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const card = getSelectedBoardCard();
                if (card) {
                    const iconBg = card.querySelector('.board-icon-bg');
                    iconBg.style.backgroundImage = ''; // 清除自定义背景图
                    iconBg.innerHTML = btn.dataset.icon; // 插入用户点击的预设图标
                    scheduleSaveState();
                    updateMinimap();
                }
            });
        });

        // 🌟 处理自定义封面上传与自动压缩
        const boardIconUpload = document.getElementById('boardIconUpload');
        const triggerBoardIconUpload = document.getElementById('triggerBoardIconUpload');
        if (triggerBoardIconUpload && boardIconUpload) {
            // 将可见按钮的点击事件转移给隐藏的 input
            triggerBoardIconUpload.addEventListener('click', () => boardIconUpload.click());
            
            boardIconUpload.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                // 核心体验提升：调用白板内置压缩引擎，防止高清图吃满本地存储空间
                compressImage(file, (compressedDataUrl) => {
                    const card = getSelectedBoardCard();
                    if (card) {
                        const iconBg = card.querySelector('.board-icon-bg');
                        iconBg.innerHTML = ''; // 清除内部的字体图标
                        // CSS 已经写好了 background-size: cover，图片会自动等比缩放并完美填充 64x64 的方块
                        iconBg.style.backgroundImage = `url('${compressedDataUrl}')`;
                        scheduleSaveState();
                        updateMinimap();
                        if (typeof showToast === 'function') showToast('封面更新成功', 'success');
                    }
                });
                
                e.target.value = ''; // 重置 input，允许下次选择同一张图片
            });
        }

                // (进入画板按钮已移除)

        function centerViewportOnActiveBoard() {
            const rootCards = Array.from(document.querySelectorAll('.card:not(.nested-card)')).filter(c => c.dataset.boardId === getActiveBoard());
            if (rootCards.length === 0) {
                panX = viewport.clientWidth / 2;
                panY = viewport.clientHeight / 2;
            } else {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                rootCards.forEach(c => {
                    const cx = parseFloat(c.style.left), cy = parseFloat(c.style.top);
                    const cw = c.offsetWidth || 300, ch = c.offsetHeight || 200;
                    if(cx < minX) minX = cx; if(cy < minY) minY = cy;
                    if(cx+cw > maxX) maxX = cx+cw; if(cy+ch > maxY) maxY = cy+ch;
                });
                const centerX = (minX + maxX) / 2;
                const centerY = (minY + maxY) / 2;
                panX = viewport.clientWidth / 2 - centerX * scale;
                panY = viewport.clientHeight / 2 - centerY * scale;
            }
            applyTransform();
        }

                // 🌟 核心新增：渲染面包屑导航
        function updateBreadcrumbs() {
            const nav = document.getElementById('breadcrumbNav');
            if (!nav) return;
            if (boardStack.length <= 1) {
                nav.classList.remove('show');
                return;
            }
            nav.classList.add('show');
            let html = '';
            boardStack.forEach((id, index) => {
                let title = '根白板';
                if (id !== ROOT_BOARD_ID) {
                    const board = document.getElementById(id);
                    title = board ? board.querySelector('.board-title').innerText : '未知画板';
                }
                const isLast = index === boardStack.length - 1;
                html += `<div class="breadcrumb-item ${isLast ? 'active' : ''}" data-index="${index}">${id === ROOT_BOARD_ID ? '<i class="fa-solid fa-house"></i> ' : ''}${escapeHtml(title)}</div>`;
                if (!isLast) html += `<div class="breadcrumb-separator"><i class="fa-solid fa-chevron-right"></i></div>`;
            });
            nav.innerHTML = html;

            // 绑定面包屑点击跳转
            nav.querySelectorAll('.breadcrumb-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    if (idx < boardStack.length - 1) { // 只有点击的不是当前层级才跳转
                        boardStack = boardStack.slice(0, idx + 1); // 截断历史栈，回到目标层级
                        refreshBoardVisibility();
                        centerViewportOnActiveBoard();
                        updateBreadcrumbs();
                        if (document.getElementById('treeDrawer').classList.contains('open')) renderBoardTree();
                    }
                });
            });
        }

        function enterBoard(boardId) {
            boardStack.push(boardId); 
            updateBreadcrumbs();
            refreshBoardVisibility();
            centerViewportOnActiveBoard();
            if (document.getElementById('treeDrawer').classList.contains('open')) renderBoardTree();
        }

        function exitBoard() {
            if (boardStack.length > 1) boardStack.pop();
            updateBreadcrumbs();
            refreshBoardVisibility();
            centerViewportOnActiveBoard();
            if (document.getElementById('treeDrawer').classList.contains('open')) renderBoardTree();
        }

        function refreshBoardVisibility() {
            const current = getActiveBoard();
            document.querySelectorAll('.card:not(.nested-card)').forEach(c => {
                // 核心防弹修复：强制使用 setProperty 和 important，绝对压制任何 CSS 的干扰
                c.style.setProperty('display', (c.dataset.boardId === current) ? 'flex' : 'none', 'important');
            });
            updateAllBoardCounts(); updateMinimap(); renderLines(); // 切换Board时重新绘制对应的线
        }

        function updateAllBoardCounts() {
            document.querySelectorAll('.board-card').forEach(b => {
                const directCards = Array.from(document.querySelectorAll('.card:not(.nested-card)')).filter(c => c.dataset.boardId === b.id);
                let boardCount = 0;
                let cardCount = 0;

                directCards.forEach(card => {
                    if (card.dataset.type === 'board') {
                        boardCount += 1;
                    } else if (card.classList.contains('column-card')) {
                        cardCount += card.querySelectorAll('.card.nested-card').length;
                        cardCount += 1; // 算上收纳列自身
                    } else {
                        cardCount += 1;
                    }
                });

                const countText = b.querySelector('.board-count');
                if(countText) {
                    // 智能组合显示文本：只有 board 或只有 card 时精简显示
                    if (boardCount === 0) {
                        countText.innerText = `${cardCount} cards`;
                    } else if (cardCount === 0) {
                        countText.innerText = `${boardCount} boards`;
                    } else {
                        countText.innerText = `${boardCount} boards ${cardCount} cards`;
                    }
                }
            });
        }

        const columnObserver = new MutationObserver((mutations) => {
            let needsUpdate = false;
            mutations.forEach(mut => {
                if (mut.target.closest('.column-drop-zone')) needsUpdate = true;
            });
            if (needsUpdate) {
                updateAllBoardCounts();
                updateMinimap();
            }
        });

        function attachCardBaseEvents(card, editorSelector = null) {
            let mouseDownX, mouseDownY;
            ensureCardConnectors(card);

            card.addEventListener('mousedown', (e) => {
                if (e.target.closest('.card')) { e.stopPropagation(); }

                // --- 连线功能：拦截锚点点击并开始画线 ---
                const connector = e.target.closest('.card-connector');
                if (connector) {
                    e.preventDefault();
                    if (!card.id) card.id = 'card-' + Date.now(); // 保证卡片有唯一ID

                    let anchor = 'top';
                    if (connector.classList.contains('card-connector-bottom')) anchor = 'bottom';
                    if (connector.classList.contains('card-connector-left')) anchor = 'left';
                    if (connector.classList.contains('card-connector-right')) anchor = 'right';

                    isDrawingLine = true;
                    lineStartData = { cardId: card.id, anchor: anchor };
                    setBoardInteractionActive(true);

                    tempLineElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    tempLineElement.classList.add('temp-line');
                    document.getElementById('linesCanvas').appendChild(tempLineElement);
                    return;
                }

                mouseDownX = e.clientX; mouseDownY = e.clientY;
                card.dataset.wasSelected = card.classList.contains('selected') ? 'true' : 'false';

                if (!card.classList.contains('selected')) {
                    clearCardSelection();
                    card.classList.add('selected');
                    updateNoteToolbar(card.classList.contains('note-card') ? card : null);
                    updateBoardToolbar(card.classList.contains('board-card') ? card : null);
                }

                // 核心修复：当笔记卡片处于编辑状态时，拦截卡片内部非文本区域（边缘、手柄等）的点击，
                // 防止浏览器默认的转移焦点行为，确保光标始终留在输入框内，不退出编辑状态。
                if (card.classList.contains('is-editing') && card.classList.contains('note-card')) {
                    if (!e.target.closest('.md-editor')) {
                        e.preventDefault();
                        const editor = card.querySelector('.md-editor');
                        if (editor && document.activeElement !== editor) {
                            editor.focus();
                        }
                    }
                }

                if (e.target.classList.contains('board-title')) return;

                // 物理缩放引擎：判断是否点击了隐形缩放热区
                const rect = card.getBoundingClientRect();
                const isHitResize = !card.classList.contains('nested-card') && !card.classList.contains('board-card') &&
                                    (e.clientX > rect.right - 20 && e.clientY > rect.bottom - 20);

                if (isHitResize) {
                    isResizingCard = true;
                    setBoardInteractionActive(true);
                    currentCard = card;
                    resizeStartSize = { w: card.offsetWidth, h: card.offsetHeight };
                    // 🌟 核心新增：若是标题卡片，额外记录它的初始字号
                    if (card.dataset.type === 'heading') {
                        const textEl = card.querySelector('.heading-text');
                        resizeStartSize.fontSize = parseFloat(window.getComputedStyle(textEl).fontSize) || 28;
                    }
                    const cPos = getCanvasCoords(e);
                    dragStartCanvasPos = { x: cPos.x, y: cPos.y };
                    e.preventDefault();
                    return;
                }

                const isInteractive = e.target.closest('[contenteditable="true"]')
                    || e.target.tagName === 'INPUT'
                    || e.target.tagName === 'TEXTAREA'
                    || e.target.tagName === 'BUTTON'
                    || e.target.closest('.todo-checkbox')
                    || e.target.closest('.comment-input-box')
                    || e.target.closest('.todo-add-btn');

                const isDragHandle = e.target.closest('.card-header')
                    || e.target.closest('.note-drag-handle')
                    || e.target.closest('.column-header-wrap')
                    || e.target.closest('.board-icon-bg')
                    || e.target.closest('.link-header') // 核心修复：仅 Link 卡片的顶部输入框区域作为拖拽手柄
                    || e.target.tagName === 'IMG'
                    || (card.classList.contains('heading-card') && !card.classList.contains('is-editing')); // 标题在非编辑状态下任意位置可拖拽

                globalMouseDownX = e.clientX; globalMouseDownY = e.clientY; // 记录全局鼠标按下坐标

                if (isDragHandle || (!isInteractive && !card.classList.contains('is-editing'))) {
                    isDraggingCard = true;
                    setBoardInteractionActive(true);
                    hasStartedDraggingMove = false; // 初始化拖拽判定锁
                    const cPos = getCanvasCoords(e);
                    dragStartCanvasPos = {x: cPos.x, y: cPos.y};

                    // 核心优化：在 mousedown 时只“记录”要拖拽的卡片，绝不立刻改变 DOM 结构。
                    // 这样才能保证后续的 click 事件能完美触发编辑模式，彻底解决“点击嵌套 Note 卡片直接被拖出”的 Bug。
                    draggedCards = Array.from(document.querySelectorAll('.card.selected')).map(c => {
                        return {
                            el: c,
                            startX: parseFloat(c.style.left) || 0,
                            startY: parseFloat(c.style.top) || 0,
                            isNested: c.classList.contains('nested-card'),
                            initialRect: c.getBoundingClientRect()
                        };
                    });
                }
            });

                        card.addEventListener('click', (e) => {
                // 🌟 新增：拦截卡片内原生超链接的点击，在非编辑/阅读模式下强制新标签页打开！
                const mdLink = e.target.closest('a');
                if (mdLink && mdLink.href && !card.classList.contains('is-editing')) {
                    e.preventDefault();
                    e.stopPropagation();
                    openExternalUrl(mdLink.href);
                    return;
                }

                // 🌟 新增：修复内联文字评论点击无法打开的 Bug！
                // 必须在 e.stopPropagation 之前处理，否则全局监听器根本收不到事件！
                const inlineComment = e.target.closest('.inline-comment');
                if (inlineComment) {
                    e.stopPropagation();
                    const linkedCommentCard = document.querySelector(`.comment-card[data-parent-card-id="${inlineComment.id}"]`);
                    if (linkedCommentCard) {
                        toggleCommentPopover(card, linkedCommentCard);
                    } else {
                        // 兜底：如果意外丢失，自动帮它重建卡片
                        const rect = card.getBoundingClientRect();
                        const vpRect = viewport.getBoundingClientRect();
                        const cx = (rect.right - vpRect.left - panX + 20) / scale;
                        const cy = (rect.top - vpRect.top - panY) / scale;
                        const newCommentCard = createCommentCard(cx, cy);
                        newCommentCard.dataset.parentCardId = inlineComment.id;
                        newCommentCard.classList.add('comment-popover-mode');
                        toggleCommentPopover(card, newCommentCard);
                        scheduleSaveState();
                    }
                    return;
                }

                e.stopPropagation();
                if (Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY) > 5) return;
                if (card.classList.contains('board-card') || card.classList.contains('image-card')) return;

                if (card.classList.contains('is-editing')) return;

                if (card.dataset.wasSelected === 'true') {
                    if (card.classList.contains('note-card')) {
                        // 🌟 核心修复：取消 true（光标强制吸底）。
                        // 允许浏览器顺其自然，让光标精准地落入你鼠标点击的表格单元格中！
                        focusNoteEditor(card, false);
                        return;
                    }

                    card.classList.add('is-editing');
                    if (editorSelector) {
                        if (card.classList.contains('table-card')) {
                           if(e.target.tagName === 'TD' || e.target.tagName === 'TH') {
                               e.target.setAttribute('contenteditable', 'true'); e.target.focus();
                               if (e.target.dataset.formula) e.target.innerText = e.target.dataset.formula;
                           }
                        } else {
                            const editors = card.querySelectorAll(editorSelector);
                            editors.forEach(editor => {
                                if (editor.tagName === 'DIV') editor.setAttribute('contenteditable', 'true');
                                if (!card.classList.contains('todo-card')) editor.focus();
                            });
                            // 保证标题卡片点击后光标在末尾
                            if (card.classList.contains('heading-card')) {
                                const textEl = card.querySelector('.heading-text');
                                if (textEl) placeCaretAtEnd(textEl);
                            }
                        }
                    }
                }
            });

            if (card.classList.contains('board-card')) {
                const iconBg = card.querySelector('.board-icon-bg');
                if(iconBg) iconBg.addEventListener('dblclick', () => { enterBoard(card.id); });
                const title = card.querySelector('.board-title');
                if(title) title.addEventListener('dblclick', (e) => { e.stopPropagation(); title.setAttribute('contenteditable', 'true'); title.focus(); });
            }

            new ResizeObserver(() => {
                updateMinimap();
                scheduleSaveState();
            }).observe(card);
            clearCardSelection();
            card.classList.add('selected');
            updateNoteToolbar(card.classList.contains('note-card') ? card : null);
            updateMinimap();
        }

        function createHeadingCard(x, y, initialContent = "", w = 150, h = 'auto') {
    const card = document.createElement('div');
    card.className = `card heading-card`;
    card.style.left = `${x}px`; card.style.top = `${y}px`;
    // 🌟 终极约束：直接在 HTML 标签上强写 max-content，彻底斩断任何宽高的介入
    card.style.width = 'max-content';
    card.style.height = 'max-content';
    card.dataset.type = "heading"; card.dataset.boardId = getActiveBoard();

    card.innerHTML = `<div class="heading-text" contenteditable="false">${initialContent}</div>`;

    const attached = attachAndReturn(card, '.heading-text');
    const textEl = attached.querySelector('.heading-text');

    textEl.addEventListener('blur', () => { attached.classList.remove('is-editing'); textEl.setAttribute('contenteditable', 'false'); scheduleSaveState(); });
    return attached;
}

        function createNoteCard(x, y, initialContent = "", w = 280, h = 180, isNested = false, noteAppearance = null) {
            const card = document.createElement('div');
            card.className = `card note-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = `${h}px`; }
            card.dataset.type = "note"; card.dataset.boardId = getActiveBoard();

            let initialHtml = initialContent || '';
            if (initialHtml && !/<[a-z][\s\S]*>/i.test(initialHtml)) {
                initialHtml = renderMarkdownToHtml(initialHtml);
            }
            // 核心修复：确保空卡片具有默认的块级结构，防止出现裸露的文本节点导致首行无法回车和 # 格式化失效
            if (!initialHtml.trim()) initialHtml = '<div><br></div>';
            card.dataset.markdown = deriveMarkdownFromHtml(initialHtml);

            card.innerHTML = `
                <div class="note-drag-handle"></div>
                <div class="md-editor" contenteditable="false">${initialHtml}</div>`;

            applyNoteAppearance(card, noteAppearance?.accentColor || noteDefaults.accentColor, noteAppearance?.backgroundColor || noteDefaults.backgroundColor);
            const attached = attachAndReturn(card, '.md-editor');
            autoGrowNoteCard(attached);
            return attached;
        }


        // ================= 核心：提权到全局的抓取与自动化引擎 =================
        // 全局增强版：多节点抗封锁代理引擎
        async function fetchWithFallback(targetUrl, timeout = 10000) {
            const proxies = [
                u => u, // 🌟 桌面端特权：第一优先级直接请求真实真实地址，不走任何代理！
                u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
                u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
                u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
            ];
            for (const makeProxy of proxies) {
                try {
                    const ctrl = new AbortController();
                    const tid = setTimeout(() => ctrl.abort(), timeout);
                    const res = await fetch(makeProxy(targetUrl), { signal: ctrl.signal });
                    clearTimeout(tid);
                    if (!res.ok) continue;
                    const txt = await res.text();
                    try {
                        const j = JSON.parse(txt);
                        if (j && j.contents !== undefined) return typeof j.contents === 'string' ? JSON.parse(j.contents) : j.contents;
                        return j;
                    } catch { return txt; }
                } catch (e) { continue; }
            }
            throw new Error('所有代理节点均被拒绝或超时');
        }

        // 核心新增：节点连线自动化触发引擎 (OSINT Pipeline)
        function checkAndTriggerAutomation(fromId, toId) {
            const fromCard = document.getElementById(fromId);
            const toCard = document.getElementById(toId);
            if (!fromCard || !toCard) return;

            // 1. Link <-> Caption (网络视频链接抓取)
            let linkCard = null;
            let captionCard = null;

            if (fromCard.dataset.type === 'link' && toCard.dataset.type === 'caption') {
                linkCard = fromCard; captionCard = toCard;
            } else if (fromCard.dataset.type === 'caption' && toCard.dataset.type === 'link') {
                linkCard = toCard; captionCard = fromCard;
            }

            if (linkCard && captionCard) {
                const url = linkCard.querySelector('.link-input').value;
                if (url) {
                    const captionInput = captionCard.querySelector('.caption-header-input input');
                    captionInput.value = url;

                    let targetId = null;
                    if (url.includes('youtu')) {
                        const ytMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/i);
                        targetId = ytMatch ? ytMatch[1] : null;
                    } else {
                        const biliMatch = url.match(/(?:bvid=|video\/|bilibili\.com\/|b23\.tv\/)(BV\w+)/i) || url.match(/^(BV\w+)/i);
                        const targetBvid = biliMatch ? biliMatch[1] : null;
                        if (targetBvid) {
                            // 精准提取分P，合成为 BVxxxx_p1 的专属 ID
                            const pMatch = url.match(/[?&]p=(\d+)/i);
                            const p = pMatch ? pMatch[1] : '1';
                            targetId = `${targetBvid}_p${p}`;
                        }
                    }

                    if (targetId) {
                        if (typeof showToast === 'function') showToast('⚡ 连线识别成功，正在直连抓取字幕...', 'info');

                        const captionList = captionCard.querySelector('.caption-list');
                        if (captionList) {
                            captionList.innerHTML = `
                                <div style="text-align:center; padding:40px 20px; color:#5b82fb;">
                                    <i class="fa-solid fa-spinner fa-spin" style="font-size: 28px; margin-bottom: 15px;"></i>
                                    <div style="font-weight:bold; font-size:14px;">正在直连抓取字幕...</div>
                                    <div style="font-size:12px; margin-top:6px; opacity:0.8;">通过公开接口解析 CC / AI 字幕</div>
                                </div>`;
                        }

                        window.__TRANSCRIPT_EXTRACTOR__.extract(url).then(lines => {
                            if (!lines || !lines.length) throw new Error('未提取到有效字幕');
                            const html = lines.map(line => `
                                <div class="caption-item">
                                    <div class="caption-time">${line.time}</div>
                                    <div class="caption-text" contenteditable="true">${escapeHtml(line.text)}</div>
                                </div>`).join('');
                            if (captionList) captionList.innerHTML = html;
                            scheduleSaveState();
                            if (typeof showToast === 'function') showToast(`✅ 直连提取成功！共 ${lines.length} 条字幕`, 'success');
                        }).catch(err => {
                            console.warn('[Caption] 连线直连失败:', err);
                            const rawMsg = (err && err.message) ? err.message : '未知错误';
                            let displayMsg = rawMsg;
                            let color = '#ef4444';
                            if (rawMsg.includes('[真空]')) {
                                displayMsg = '该视频未提供任何 CC / AI 字幕轨道。';
                                color = '#f59e0b';
                            }
                            if (captionList) {
                                captionList.innerHTML = `<div style="padding:20px; color:${color}; line-height:1.5;">❌ 字幕提取失败：<br>${escapeHtml(displayMsg)}</div>`;
                            }
                        });
                    } else {
                        if (typeof showToast === 'function') showToast('⚠️ 链接中未识别到有效的 B站 或 YouTube 视频 ID', 'warning');
                    }
                }
                return;
            }

            // 2. Note <-> Caption (本地文本正则智能解析)
            // 解决白板内无法点击字幕按钮的问题：直接将存有油猴字幕的 Note 笔记连线到 Caption 即可解析
            let noteCard = null;
            let captionCardForNote = null;

            if (fromCard.dataset.type === 'note' && toCard.dataset.type === 'caption') {
                noteCard = fromCard; captionCardForNote = toCard;
            } else if (fromCard.dataset.type === 'caption' && toCard.dataset.type === 'note') {
                noteCard = toCard; captionCardForNote = fromCard;
            }

            if (noteCard && captionCardForNote) {
                const editor = noteCard.querySelector('.md-editor');
                if (!editor) return;

                // 获取纯文本内容
                const text = editor.innerText || '';

                // 嗅探是否为油猴脚本的特有格式 (如 "01:23 字幕内容" 或 "12:34:56 字幕")
                if (/\d{2}:\d{2}/.test(text)) {
                    const lines = text.trim().split('\n');
                    let newHtml = '';
                    let count = 0;

                    lines.forEach(line => {
                        // 兼容 MM:SS 或 HH:MM:SS 等多种时间戳格式
                        const match = line.trim().match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)/);
                        if (match) {
                            newHtml += `
                                <div class="caption-item">
                                    <div class="caption-time">${match[1]}</div>
                                    <div class="caption-text" contenteditable="true">${escapeHtml(match[2] || '')}</div>
                                </div>`;
                            count++;
                        }
                    });

                    if (newHtml) {
                        const list = captionCardForNote.querySelector('.caption-list');
                        if (list) {
                            list.innerHTML = newHtml;
                            scheduleSaveState();
                            if (typeof showToast === 'function') showToast(`✅ 连线解析成功！已从笔记自动提取 ${count} 条字幕。`, 'success');
                        }
                    } else {
                        if (typeof showToast === 'function') showToast('⚠️ 未在笔记中检测到标准时间戳格式的字幕', 'warning');
                    }
                }
            }
        }

        function createLinkCard(x, y, initialUrl = "", isNested = false, savedArticleClip = null) {
            const card = document.createElement('div');
            card.className = `card link-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `380px`; card.style.height = `auto`; }
            card.dataset.type = "link"; card.dataset.boardId = getActiveBoard();

            card.innerHTML = `
                <div class="link-header">
                    <div class="link-icon-wrap"><i class="fa-solid fa-link"></i></div>
                    <input type="text" class="link-input" placeholder="输入新闻 / 网站 / 视频链接..." value="${escapeAttribute(initialUrl)}">
                </div>
                <div class="link-preview-content" style="display:none;"></div>
            `;
            const attached = attachAndReturn(card, '.link-input');
            const input = attached.querySelector('.link-input');
            const previewContent = attached.querySelector('.link-preview-content');
            if (savedArticleClip && typeof savedArticleClip === 'object') attached._articleClip = savedArticleClip;
            const VIDEO_CARD_WIDTH = 960;
            const VIDEO_CARD_HEIGHT = 610;
            const EMBED_APP_ORIGIN = 'https://noteboard.local';
            let localPlayerOrigin = '';

            function ensureLocalPlayerOrigin() {
                if (localPlayerOrigin) return Promise.resolve(localPlayerOrigin);
                try {
                    const { ipcRenderer } = require('electron');
                    return ipcRenderer.invoke('get-local-player-origin')
                        .then(origin => {
                            localPlayerOrigin = origin || '';
                            return localPlayerOrigin;
                        })
                        .catch(() => '');
                } catch {
                    return Promise.resolve('');
                }
            }

            function setVideoCardSize() {
                if (!card.classList.contains('nested-card')) {
                    card.style.width = `${VIDEO_CARD_WIDTH}px`;
                    card.style.height = `${VIDEO_CARD_HEIGHT}px`;
                }
            }

            // 扩展 URL 识别（支持 youtu.be / shorts / b23.tv / av号）
            function parseVideoUrl(url) {
                const value = String(url || '').trim();
                const ytMatch = value.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
                if (ytMatch) return { type: 'youtube', id: ytMatch[1] };
                const pageMatch = value.match(/[?&](?:p|page)=(\d+)/i);
                const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10) || 1) : 1;
                const biliBvMatch = value.match(/(?:bvid=|bilibili\.com\/video\/)(BV[a-zA-Z0-9]+)/i) || value.match(/\b(BV[a-zA-Z0-9]+)/i);
                if (biliBvMatch) return { type: 'bilibili', id: biliBvMatch[1], idType: 'bv', page };
                const biliAvMatch = value.match(/bilibili\.com\/video\/av(\d+)/i) || value.match(/[?&]aid=(\d+)/i);
                if (biliAvMatch) return { type: 'bilibili', id: biliAvMatch[1], idType: 'av', page };
                return null;
            }

            function normalizeLinkUrl(rawUrl) {
                const value = String(rawUrl || '').trim();
                if (!value) return '';
                if (/^https?:\/\//i.test(value)) return value;
                if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return `https://${value}`;
                return value;
            }

            function getYouTubeWatchUrl(videoId, originalUrl) {
                try {
                    const urlObj = new URL(originalUrl);
                    const start = urlObj.searchParams.get('t') || urlObj.searchParams.get('start');
                    const watchUrl = new URL('https://www.youtube.com/watch');
                    watchUrl.searchParams.set('v', videoId);
                    if (start) watchUrl.searchParams.set('t', start);
                    return watchUrl.href;
                } catch {
                    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
                }
            }

            function getBilibiliWatchUrl(videoId, idType, originalUrl) {
                try {
                    const urlObj = new URL(originalUrl);
                    if (/bilibili\.com$/i.test(urlObj.hostname) || /\.bilibili\.com$/i.test(urlObj.hostname)) return urlObj.href;
                } catch {}
                return `https://www.bilibili.com/video/${idType === 'bv' ? videoId : `av${videoId}`}`;
            }

            function parseVideoStartSeconds(value) {
                const raw = String(value || '').trim().toLowerCase();
                if (!raw) return 0;
                if (/^\d+$/.test(raw)) return parseInt(raw, 10) || 0;
                if (/^\d+(?::\d+){1,2}$/.test(raw)) {
                    return raw.split(':').reduce((total, part) => total * 60 + (parseInt(part, 10) || 0), 0);
                }
                const h = raw.match(/(\d+)h/);
                const m = raw.match(/(\d+)m/);
                const s = raw.match(/(\d+)s/);
                return (h ? parseInt(h[1], 10) * 3600 : 0)
                    + (m ? parseInt(m[1], 10) * 60 : 0)
                    + (s ? parseInt(s[1], 10) : 0);
            }

            function getYouTubeEmbedUrl(videoId, originalUrl) {
                const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
                embedUrl.searchParams.set('autoplay', '1');
                embedUrl.searchParams.set('rel', '0');
                embedUrl.searchParams.set('playsinline', '1');
                embedUrl.searchParams.set('enablejsapi', '1');
                embedUrl.searchParams.set('modestbranding', '1');
                embedUrl.searchParams.set('origin', EMBED_APP_ORIGIN);
                embedUrl.searchParams.set('widget_referrer', EMBED_APP_ORIGIN);
                try {
                    const urlObj = new URL(originalUrl);
                    const start = parseVideoStartSeconds(urlObj.searchParams.get('start') || urlObj.searchParams.get('t'));
                    if (start) embedUrl.searchParams.set('start', String(start));
                } catch {}
                return embedUrl.href;
            }

            function getYouTubeFallbackEmbedUrl(videoId, originalUrl) {
                const embedUrl = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
                embedUrl.searchParams.set('autoplay', '1');
                embedUrl.searchParams.set('rel', '0');
                embedUrl.searchParams.set('playsinline', '1');
                embedUrl.searchParams.set('enablejsapi', '1');
                embedUrl.searchParams.set('modestbranding', '1');
                embedUrl.searchParams.set('origin', EMBED_APP_ORIGIN);
                embedUrl.searchParams.set('widget_referrer', EMBED_APP_ORIGIN);
                try {
                    const urlObj = new URL(originalUrl);
                    const start = parseVideoStartSeconds(urlObj.searchParams.get('start') || urlObj.searchParams.get('t'));
                    if (start) embedUrl.searchParams.set('start', String(start));
                } catch {}
                return embedUrl.href;
            }

            function getYouTubeStartParam(originalUrl) {
                try {
                    const urlObj = new URL(originalUrl);
                    const start = parseVideoStartSeconds(urlObj.searchParams.get('start') || urlObj.searchParams.get('t'));
                    return start ? String(start) : '';
                } catch {
                    return '';
                }
            }

            function getYouTubeFrontendEmbedUrl(baseUrl, videoId, originalUrl) {
                const embedUrl = new URL(`${baseUrl.replace(/\/$/, '')}/embed/${videoId}`);
                embedUrl.searchParams.set('autoplay', '1');
                const start = getYouTubeStartParam(originalUrl);
                if (start) embedUrl.searchParams.set('start', start);
                return embedUrl.href;
            }

            function getYouTubePlayerSources(videoId, originalUrl) {
                return [
                    { label: '官方', title: 'YouTube 官方隐私增强播放源', url: getYouTubeFallbackEmbedUrl(videoId, originalUrl), kind: 'youtube' },
                    { label: 'YouTube', title: 'YouTube 标准播放源', url: getYouTubeEmbedUrl(videoId, originalUrl), kind: 'youtube' },
                    { label: 'Yewtu', title: 'Invidious 播放源', url: getYouTubeFrontendEmbedUrl('https://yewtu.be', videoId, originalUrl), kind: 'frontend' },
                    { label: 'Piped', title: 'Piped 播放源', url: getYouTubeFrontendEmbedUrl('https://piped.video', videoId, originalUrl), kind: 'frontend' }
                ];
            }

            function getBilibiliEmbedUrl(videoId, idType, originalUrl, page = 1, quality = 80, cid = '') {
                const embedUrl = new URL('https://player.bilibili.com/player.html');
                embedUrl.searchParams.set('isOutside', 'true');
                embedUrl.searchParams.set('autoplay', '1');
                embedUrl.searchParams.set('high_quality', '1');
                embedUrl.searchParams.set('as_wide', '1');
                embedUrl.searchParams.set('quality', String(quality));
                embedUrl.searchParams.set('qn', String(quality));
                embedUrl.searchParams.set('danmaku', '0');
                embedUrl.searchParams.set(idType === 'bv' ? 'bvid' : 'aid', videoId);
                embedUrl.searchParams.set('page', String(Math.max(1, page || 1)));
                if (cid) embedUrl.searchParams.set('cid', String(cid));
                try {
                    const urlObj = new URL(originalUrl);
                    const start = parseVideoStartSeconds(urlObj.searchParams.get('t') || urlObj.searchParams.get('start'));
                    if (start) embedUrl.searchParams.set('t', String(start));
                } catch {}
                return embedUrl.href;
            }

            function renderEmbeddedVideo(thumbWrap, embedUrl, title, externalUrl = '', options = {}) {
                if (!thumbWrap || thumbWrap.querySelector('iframe, webview')) return;
                const videoSurface = options.useWebview
                    ? `<webview
                        class="embedded-video-frame embedded-video-webview"
                        src="${escapeAttribute(embedUrl)}"
                        partition="persist:noteboard-videos"
                        allowpopups
                        style="position:absolute; inset:0; width:100%; height:100%; border:0; background:#000;"
                    ></webview>`
                    : `<iframe
                        class="embedded-video-frame"
                        src="${escapeAttribute(embedUrl)}"
                        title="${escapeAttribute(title)}"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowfullscreen
                        referrerpolicy="strict-origin-when-cross-origin"
                        ${options.sandbox ? `sandbox="${escapeAttribute(options.sandbox)}"` : ''}
                        style="position:absolute; inset:0; width:100%; height:100%; border:0; background:#000;"
                    ></iframe>`;
                thumbWrap.innerHTML = `
                    ${videoSurface}
                    ${externalUrl ? `
                        <div data-open-url="${escapeAttribute(externalUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.65); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:3;" title="在浏览器打开">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                        </div>
                    ` : ''}
                    ${options.fallbackUrl ? `
                        <div data-switch-embed-url="${escapeAttribute(options.fallbackUrl)}" style="position:absolute; top:10px; right:10px; background:rgba(0,0,0,0.65); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:3;" title="切换备用播放器">
                            <i class="fa-solid fa-rotate"></i> 备用线路
                        </div>
                    ` : ''}
                `;
                const webview = thumbWrap.querySelector('webview');
                if (webview) {
                    webview.addEventListener('new-window', (event) => {
                        if (typeof event.preventDefault === 'function') event.preventDefault();
                        if (event.url && /(^https?:\/\/([^/]+\.)?bilibili\.com\/)/i.test(event.url)) webview.loadURL(event.url);
                        else if (event.url) openExternalUrl(event.url);
                    });
                }
                updateMinimap();
                scheduleSaveState();
            }

            function renderYouTubePlayer(thumbWrap, sources, externalUrl, activeIndex = 0) {
                if (!thumbWrap || !Array.isArray(sources) || sources.length === 0) return;
                const active = sources[Math.max(0, Math.min(activeIndex, sources.length - 1))] || sources[0];
                thumbWrap.innerHTML = `
                    <iframe
                        class="embedded-video-frame youtube-player-frame"
                        src="${escapeAttribute(active.url)}"
                        title="YouTube video player"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowfullscreen
                        referrerpolicy="strict-origin-when-cross-origin"
                        style="position:absolute; inset:0; width:100%; height:100%; border:0; background:#000;"
                    ></iframe>
                    <div data-open-url="${escapeAttribute(externalUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.65); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:4;" title="在浏览器打开">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                    </div>
                    <div class="youtube-source-controls" style="position:absolute; top:10px; right:10px; z-index:4; display:flex; gap:6px; background:rgba(0,0,0,0.62); color:#fff; padding:6px; border-radius:7px; font-size:11px;">
                        ${sources.map((source, index) => `
                            <button type="button" class="yt-source-btn" data-yt-source-index="${index}" title="${escapeAttribute(source.title)}" style="border:0; border-radius:5px; padding:4px 7px; color:#fff; cursor:pointer; background:${source === active ? '#ef4444' : 'rgba(255,255,255,0.14)'}; font-size:11px;">${escapeHtml(source.label)}</button>
                        `).join('')}
                    </div>
                `;
                thumbWrap.querySelectorAll('.yt-source-btn').forEach(button => {
                    button.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const nextIndex = parseInt(button.dataset.ytSourceIndex, 10) || 0;
                        renderYouTubePlayer(thumbWrap, sources, externalUrl, nextIndex);
                    });
                });
                updateMinimap();
                scheduleSaveState();
            }

            function renderBilibiliQualityControls(thumbWrap, buildUrl, currentQuality = 80) {
                if (!thumbWrap) return;
                const old = thumbWrap.querySelector('.bili-quality-controls');
                if (old) old.remove();
                const controls = document.createElement('div');
                controls.className = 'bili-quality-controls';
                controls.style.cssText = 'position:absolute; top:10px; right:10px; z-index:4; display:flex; gap:6px; background:rgba(0,0,0,0.62); color:#fff; padding:6px; border-radius:7px; font-size:11px;';
                const options = [
                    { qn: 80, label: '1080' },
                    { qn: 64, label: '720' },
                    { qn: 32, label: '480' },
                    { qn: 16, label: '360' }
                ];
                options.forEach(option => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.textContent = option.label;
                    btn.dataset.qn = String(option.qn);
                    btn.style.cssText = `border:0; border-radius:5px; padding:4px 7px; color:#fff; cursor:pointer; background:${option.qn === currentQuality ? '#00a1d6' : 'rgba(255,255,255,0.14)'}; font-size:11px;`;
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const frame = thumbWrap.querySelector('iframe.embedded-video-frame');
                        if (!frame) return;
                        frame.src = buildUrl(option.qn);
                        renderBilibiliQualityControls(thumbWrap, buildUrl, option.qn);
                    });
                    controls.appendChild(btn);
                });
                thumbWrap.appendChild(controls);
            }

            function renderBilibiliDirectQualityControls(thumbWrap, playQuality, currentQuality = 80) {
                if (!thumbWrap) return;
                const old = thumbWrap.querySelector('.bili-quality-controls');
                if (old) old.remove();
                const controls = document.createElement('div');
                controls.className = 'bili-quality-controls';
                controls.style.cssText = 'position:absolute; top:10px; right:10px; z-index:4; display:flex; gap:6px; background:rgba(0,0,0,0.62); color:#fff; padding:6px; border-radius:7px; font-size:11px;';
                [
                    { qn: 80, label: '1080' },
                    { qn: 64, label: '720' },
                    { qn: 32, label: '480' },
                    { qn: 16, label: '360' }
                ].forEach(option => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.textContent = option.label;
                    btn.style.cssText = `border:0; border-radius:5px; padding:4px 7px; color:#fff; cursor:pointer; background:${option.qn === currentQuality ? '#00a1d6' : 'rgba(255,255,255,0.14)'}; font-size:11px;`;
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        playQuality(option.qn);
                    });
                    controls.appendChild(btn);
                });
                thumbWrap.appendChild(controls);
            }

            function getHostname(url) {
                try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return url; }
            }

            function cleanArticleText(value) {
                return String(value || '').replace(/\s+/g, ' ').trim();
            }

            function resolveArticleUrl(value, baseUrl) {
                const raw = String(value || '').trim();
                if (!raw || raw.startsWith('data:')) return '';
                try { return new URL(raw, baseUrl).href; } catch { return ''; }
            }

            function getMetaContent(doc, name) {
                return doc.querySelector(`meta[property="${name}"]`)?.getAttribute('content')
                    || doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')
                    || '';
            }

            function coerceHtmlResponse(payload) {
                if (typeof payload === 'string') {
                    const trimmed = payload.trim();
                    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed && typeof parsed.contents === 'string') return parsed.contents;
                        } catch {}
                    }
                    return payload;
                }
                if (payload && typeof payload.contents === 'string') return payload.contents;
                return String(payload || '');
            }

            function resolveImageSource(img, baseUrl) {
                const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
                const srcsetCandidate = srcset ? srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
                const candidates = [
                    img.getAttribute('src'),
                    img.getAttribute('data-src'),
                    img.getAttribute('data-original'),
                    img.getAttribute('data-lazy-src'),
                    img.getAttribute('data-url'),
                    srcsetCandidate
                ].filter(Boolean);
                for (const candidate of candidates) {
                    const resolved = resolveArticleUrl(candidate, baseUrl);
                    if (resolved) return resolved;
                }
                return '';
            }

            function isProtectedArticleNode(el) {
                const marker = `${el.tagName || ''} ${el.id || ''} ${el.className || ''}`.toLowerCase();
                return el.tagName === 'ARTICLE'
                    || el.tagName === 'MAIN'
                    || marker.includes('article-body')
                    || marker.includes('article-content')
                    || marker.includes('story-body')
                    || marker.includes('entry-content')
                    || marker.includes('post-content');
            }

            function removeArticleNoise(root) {
                root.querySelectorAll('script, style, noscript, svg, canvas, iframe, form, input, button, select, textarea, nav, footer, aside, dialog, template, [hidden]').forEach(el => el.remove());
                const noisePattern = /(^|[\s_-])(ad|ads|advert|advertisement|banner|cookie|modal|popup|subscribe|newsletter|share|social|comment|comments|related|recommend|promo|breadcrumb|nav|footer|sidebar|aside|sponsor|paywall)([\s_-]|$)/i;
                root.querySelectorAll('[class], [id], [role]').forEach(el => {
                    if (isProtectedArticleNode(el)) return;
                    const marker = `${el.id || ''} ${el.className || ''} ${el.getAttribute('role') || ''}`;
                    if (noisePattern.test(marker)) el.remove();
                });
            }

            function scoreArticleElement(el) {
                const text = cleanArticleText(el.textContent);
                if (text.length < 120) return 0;
                const marker = `${el.tagName || ''} ${el.id || ''} ${el.className || ''}`.toLowerCase();
                const linksText = cleanArticleText(Array.from(el.querySelectorAll('a')).map(a => a.textContent).join(' '));
                const linkDensity = linksText.length / Math.max(text.length, 1);
                const paragraphs = Array.from(el.querySelectorAll('p, li, blockquote')).map(p => cleanArticleText(p.textContent)).filter(t => t.length > 35);
                let score = Math.min(text.length, 8000) * 0.18 + paragraphs.reduce((sum, t) => sum + Math.min(t.length, 700), 0) + paragraphs.length * 35;
                if (el.tagName === 'ARTICLE') score += 500;
                if (marker.includes('article') || marker.includes('story') || marker.includes('post') || marker.includes('entry')) score += 220;
                if (marker.includes('content') || marker.includes('body')) score += 120;
                if (/comment|related|recommend|sidebar|footer|nav|share|social|ad/.test(marker)) score -= 650;
                score -= linkDensity * 1400;
                return score;
            }

            function chooseArticleCandidate(doc) {
                const selectors = [
                    'article',
                    'main article',
                    'main',
                    '[itemprop="articleBody"]',
                    '[data-testid="article-body"]',
                    '[class*="article-body"]',
                    '[class*="article-content"]',
                    '[class*="story-body"]',
                    '[class*="post-content"]',
                    '[class*="entry-content"]',
                    '[class*="news-content"]',
                    '[class*="content-body"]'
                ];
                const candidates = [];
                selectors.forEach(selector => {
                    doc.querySelectorAll(selector).forEach(el => {
                        if (!candidates.includes(el)) candidates.push(el);
                    });
                });
                if (candidates.length === 0) {
                    doc.querySelectorAll('section, div').forEach(el => {
                        if (cleanArticleText(el.textContent).length > 300) candidates.push(el);
                    });
                }
                let best = null;
                let bestScore = 0;
                candidates.forEach(el => {
                    const score = scoreArticleElement(el);
                    if (score > bestScore) {
                        best = el;
                        bestScore = score;
                    }
                });
                return bestScore > 180 ? best : null;
            }

            function collectFallbackParagraphs(root) {
                const result = [];
                const seen = new Set();
                root.querySelectorAll('p, li, blockquote, div').forEach(el => {
                    if (Array.from(el.children).some(child => cleanArticleText(child.textContent).length > 120)) return;
                    const text = cleanArticleText(el.textContent);
                    if (text.length < 45 || seen.has(text)) return;
                    if (result.some(prev => prev.includes(text) || text.includes(prev))) return;
                    seen.add(text);
                    result.push(text);
                });
                return result.slice(0, 80);
            }

            function sanitizeArticleFragment(sourceEl, baseUrl) {
                const clone = sourceEl.cloneNode(true);
                removeArticleNoise(clone);
                clone.querySelectorAll('img').forEach(img => {
                    const resolved = resolveImageSource(img, baseUrl);
                    if (resolved) img.setAttribute('src', resolved);
                    else img.remove();
                });

                const allowedTags = new Set(['P', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'A', 'STRONG', 'B', 'EM', 'I', 'IMG', 'FIGURE', 'FIGCAPTION', 'BR', 'HR']);
                const flattenTags = new Set(['ARTICLE', 'MAIN', 'DIV', 'SECTION', 'SPAN', 'HEADER']);
                const output = document.createElement('div');

                function cleanNode(node) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        return document.createTextNode(node.textContent || '');
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) return null;

                    const tag = node.tagName;
                    if (tag === 'IMG') {
                        const src = resolveImageSource(node, baseUrl);
                        if (!src) return null;
                        const img = document.createElement('img');
                        img.src = src;
                        img.alt = cleanArticleText(node.getAttribute('alt') || '');
                        img.loading = 'lazy';
                        return img;
                    }

                    if (!allowedTags.has(tag)) {
                        const fragment = document.createDocumentFragment();
                        if (flattenTags.has(tag) || node.childNodes.length) {
                            Array.from(node.childNodes).forEach(child => {
                                const cleaned = cleanNode(child);
                                if (cleaned) fragment.appendChild(cleaned);
                            });
                        }
                        return fragment.childNodes.length ? fragment : null;
                    }

                    const el = document.createElement(tag.toLowerCase());
                    if (tag === 'A') {
                        const href = resolveArticleUrl(node.getAttribute('href'), baseUrl);
                        if (href && /^(https?:|mailto:)/i.test(href)) {
                            el.href = href;
                            el.target = '_blank';
                            el.rel = 'noopener noreferrer';
                        }
                    }
                    Array.from(node.childNodes).forEach(child => {
                        const cleaned = cleanNode(child);
                        if (cleaned) el.appendChild(cleaned);
                    });
                    if (['P', 'H2', 'H3', 'H4', 'LI', 'BLOCKQUOTE'].includes(tag) && !cleanArticleText(el.textContent) && !el.querySelector('img')) return null;
                    return el;
                }

                Array.from(clone.childNodes).forEach(node => {
                    const cleaned = cleanNode(node);
                    if (cleaned) output.appendChild(cleaned);
                });

                if (cleanArticleText(output.textContent).length < 180) {
                    const fallbackParagraphs = collectFallbackParagraphs(clone);
                    if (fallbackParagraphs.length) {
                        output.innerHTML = fallbackParagraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('');
                    }
                }
                return output.innerHTML.trim();
            }

            function formatArticleDate(value) {
                const raw = cleanArticleText(value);
                if (!raw) return '';
                const date = new Date(raw);
                return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString();
            }

            function extractReadableArticle(html, sourceUrl) {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const hostname = getHostname(sourceUrl);
                const title = cleanArticleText(
                    getMetaContent(doc, 'og:title')
                    || getMetaContent(doc, 'twitter:title')
                    || doc.querySelector('h1')?.textContent
                    || doc.title
                    || hostname
                );
                const excerpt = cleanArticleText(
                    getMetaContent(doc, 'og:description')
                    || getMetaContent(doc, 'twitter:description')
                    || getMetaContent(doc, 'description')
                );
                const siteName = cleanArticleText(getMetaContent(doc, 'og:site_name')) || hostname;
                const byline = cleanArticleText(
                    getMetaContent(doc, 'author')
                    || getMetaContent(doc, 'article:author')
                    || doc.querySelector('[rel="author"], .byline, .author, [class*="author"]')?.textContent
                );
                const published = formatArticleDate(
                    getMetaContent(doc, 'article:published_time')
                    || doc.querySelector('time[datetime]')?.getAttribute('datetime')
                    || doc.querySelector('time')?.textContent
                );
                let image = getMetaContent(doc, 'og:image') || getMetaContent(doc, 'twitter:image') || '';
                image = resolveArticleUrl(image, sourceUrl);

                removeArticleNoise(doc);
                const candidate = chooseArticleCandidate(doc);
                if (!candidate) return null;
                const contentHtml = sanitizeArticleFragment(candidate, sourceUrl);
                const temp = document.createElement('div');
                temp.innerHTML = contentHtml;
                const bodyText = cleanArticleText(temp.textContent);
                if (bodyText.length < 220) return null;

                return {
                    url: sourceUrl,
                    title,
                    siteName,
                    hostname,
                    byline,
                    published,
                    excerpt,
                    image,
                    contentHtml,
                    clippedAt: Date.now()
                };
            }

            function setArticleClip(clip) {
                attached._articleClip = clip || null;
                attached.classList.toggle('has-article-clip', !!clip);
            }

            function renderArticleClip(clip) {
                setArticleClip(clip);
                if (!attached.classList.contains('nested-card')) {
                    attached.style.width = attached.style.width && parseFloat(attached.style.width) > 600 ? attached.style.width : '640px';
                    attached.style.height = attached.style.height && parseFloat(attached.style.height) > 260 ? attached.style.height : '620px';
                }
                const metaBits = [clip.siteName || clip.hostname, clip.byline, clip.published].filter(Boolean);
                previewContent.style.display = 'flex';
                previewContent.innerHTML = `
                    <article class="article-clip">
                        ${clip.image ? `<img class="article-clip-cover" src="${escapeAttribute(clip.image)}" alt="" loading="lazy">` : ''}
                        <div class="article-clip-head">
                            <div class="article-clip-kicker">${escapeHtml(metaBits.join(' · '))}</div>
                            <div class="article-clip-title">${escapeHtml(clip.title || clip.hostname || '网页剪藏')}</div>
                            ${clip.excerpt ? `<div class="article-clip-excerpt">${escapeHtml(clip.excerpt)}</div>` : ''}
                            <div class="article-clip-toolbar">
                                <button type="button" class="article-clip-action" data-refresh-clip title="重新抓取正文"><i class="fa-solid fa-rotate-right"></i></button>
                                <button type="button" class="article-clip-action" data-open-url="${escapeAttribute(clip.url)}" title="打开原网页"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                            </div>
                        </div>
                        <div class="article-clip-body">${clip.contentHtml}</div>
                    </article>
                `;
                updateMinimap();
                scheduleSaveState();
            }

            function updatePreview(url) {
                const normalizedUrl = normalizeLinkUrl(url);
                if (normalizedUrl && normalizedUrl !== input.value.trim() && /^https?:\/\//i.test(normalizedUrl)) {
                    input.value = normalizedUrl;
                }
                if (!normalizedUrl.trim()) {
                    setArticleClip(null);
                    previewContent.style.display = 'none'; previewContent.innerHTML = '';
                    if (!card.classList.contains('nested-card')) { card.style.width = '380px'; card.style.height = 'auto'; }
                    return;
                }
                const video = parseVideoUrl(normalizedUrl);
                previewContent.style.display = 'flex';
                if (video && video.type === 'youtube') {
                    setArticleClip(null);
                    renderYouTubeCard(video.id, normalizedUrl);
                }
                else if (video && video.type === 'bilibili') {
                    setArticleClip(null);
                    renderBilibiliCard(video.id, video.idType, normalizedUrl, video.page);
                }
                else renderWebCard(normalizedUrl);
            }

            // YouTube: 缩略图先行 + 点击播放 分辨率
            function renderYouTubeCard(videoId, url) {
                setVideoCardSize();
                const thumb = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                const watchUrl = getYouTubeWatchUrl(videoId, url);
                previewContent.innerHTML = `
                    <div class="video-thumbnail-wrap" style="flex:1; width:100%; position:relative; background:#000; min-height:0; overflow:hidden; cursor:pointer;">
                        <img src="${thumb}" style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover;" onerror="this.src='https://img.youtube.com/vi/${videoId}/0.jpg'">
                        <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.25);">
                            <div style="width:68px; height:48px; background:rgba(255,0,0,0.92); border-radius:14px; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                                <i class="fa-solid fa-play" style="color:#fff; font-size:22px; margin-left:4px;"></i>
                            </div>
                        </div>
                        <div data-open-url="${escapeAttribute(watchUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.6); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:3;" title="在浏览器打开">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                        </div>
                    </div>
                    <div class="video-meta-wrapper" style="background:#fff; flex-shrink:0; border-top:1px solid #eaeaea;">
                        <div class="link-loading" style="padding:12px; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在抓取视频信息...</div>
                    </div>
                `;
                const thumbWrap = previewContent.querySelector('.video-thumbnail-wrap');
                thumbWrap.addEventListener('click', (e) => {
                    if (e.target.closest('[data-open-url]')) return;
                    e.stopPropagation();
                    thumbWrap.style.cursor = 'progress';
                    renderYouTubePlayer(thumbWrap, getYouTubePlayerSources(videoId, url), watchUrl, 0);
                    thumbWrap.style.cursor = 'default';
                });

                const metaWrap = previewContent.querySelector('.video-meta-wrapper');
                fetch(`https://noembed.com/embed?dataType=json&url=${encodeURIComponent(url)}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.title) {
                            metaWrap.innerHTML = `
                                <div style="padding:12px 16px;">
                                    <div style="font-size:14px; font-weight:600; color:#333; -webkit-line-clamp:2; display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4;">${data.title}</div>
                                    <div style="margin-top:6px; font-size:12px; color:#8a94a6;"><span style="color:#ff0000; font-weight:bold;">YouTube</span> • ${data.author_name || 'Creator'}</div>
                                </div>`;
                        } else metaWrap.style.display = 'none';
                        updateMinimap(); scheduleSaveState();
                    }).catch(() => metaWrap.style.display = 'none');
            }

            // Bilibili: 封面先行 + 点击播放，weserv 代理绕过防盗链
            function renderBilibiliCard(videoId, idType, url, page = 1) {
                setVideoCardSize();
                const watchUrl = getBilibiliWatchUrl(videoId, idType, url);
                let biliCid = '';
                const buildBiliEmbedUrl = (quality = 80) => getBilibiliEmbedUrl(videoId, idType, url, page, quality, biliCid);
                let embedUrl = buildBiliEmbedUrl(80);
                let metadataReady = Promise.resolve(null);
                previewContent.innerHTML = `
                    <div class="video-thumbnail-wrap" style="flex:1; width:100%; position:relative; background:linear-gradient(135deg,#0c2b3a,#00a1d6); min-height:0; overflow:hidden; cursor:pointer;">
                        <div class="bili-cover" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff;">
                            <div style="text-align:center; opacity:.8;">
                                <div style="font-size:36px; margin-bottom:6px;">📺</div>
                                <div style="font-size:12px;">获取封面中...</div>
                            </div>
                        </div>
                        <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.15); z-index:2;">
                            <div style="width:68px; height:48px; background:rgba(0,161,214,0.95); border-radius:14px; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                                <i class="fa-solid fa-play" style="color:#fff; font-size:22px; margin-left:4px;"></i>
                            </div>
                        </div>
                        <div data-open-url="${escapeAttribute(watchUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.6); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:3;" title="在浏览器打开">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                        </div>
                    </div>
                    <div class="video-meta-wrapper" style="background:#fff; flex-shrink:0; border-top:1px solid #eaeaea;">
                        <div class="link-loading" style="padding:12px; font-size:12px;"><i class="fa-solid fa-spinner fa-spin"></i> 正在抓取视频信息...</div>
                    </div>
                `;
                const thumbWrap = previewContent.querySelector('.video-thumbnail-wrap');
                const metaWrap = previewContent.querySelector('.video-meta-wrapper');
                const getBiliPayload = (quality) => ({
                    bvid: idType === 'bv' ? videoId : '',
                    aid: idType === 'av' ? videoId : '',
                    cid: biliCid,
                    qn: quality
                });
                const playIframeFallback = () => {
                    thumbWrap.innerHTML = '';
                    renderEmbeddedVideo(thumbWrap, embedUrl, 'Bilibili video player', watchUrl, {
                        sandbox: 'allow-same-origin allow-scripts allow-forms allow-presentation'
                    });
                    renderBilibiliQualityControls(thumbWrap, buildBiliEmbedUrl, 80);
                };
                const playDirect = async (quality = 80) => {
                    const currentTime = thumbWrap.querySelector('video')?.currentTime || 0;
                    thumbWrap.innerHTML = `
                        <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:#050505; color:#fff; font-size:13px;">
                            <i class="fa-solid fa-spinner fa-spin" style="margin-right:8px;"></i> 正在切换 ${quality === 80 ? '1080' : quality === 64 ? '720' : quality === 32 ? '480' : '360'}P...
                        </div>
                        <div data-open-url="${escapeAttribute(watchUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.65); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:4;" title="在浏览器打开">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                        </div>
                    `;
                    try {
                        if (!biliCid) await metadataReady;
                        if (!biliCid) throw new Error('缺少 B站 cid');
                        const { ipcRenderer } = require('electron');
                        const stream = await ipcRenderer.invoke('bilibili-play-url', getBiliPayload(quality));
                        if (!stream?.url) throw new Error('B站没有返回视频流');
                        const actualQuality = Number(stream.quality || quality);
                        const streamUrls = [stream.url].concat(stream.backupUrls || []).filter(Boolean);
                        thumbWrap.innerHTML = `
                            <video class="embedded-video-frame bili-direct-video" controls autoplay playsinline style="position:absolute; inset:0; width:100%; height:100%; border:0; background:#000;">
                                ${streamUrls.map(sourceUrl => `<source src="${escapeAttribute(sourceUrl)}">`).join('')}
                            </video>
                            <div data-open-url="${escapeAttribute(watchUrl)}" style="position:absolute; top:10px; left:10px; background:rgba(0,0,0,0.65); color:#fff; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; align-items:center; gap:5px; cursor:pointer; z-index:4;" title="在浏览器打开">
                                <i class="fa-solid fa-arrow-up-right-from-square"></i> 浏览器打开
                            </div>
                        `;
                        const video = thumbWrap.querySelector('video');
                        video.addEventListener('loadedmetadata', () => {
                            if (currentTime > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(currentTime, Math.max(video.duration - 1, 0));
                            video.play().catch(() => {});
                        }, { once: true });
                        video.addEventListener('error', () => {
                            if (typeof showToast === 'function') showToast('B站直连播放失败，已回退到嵌入播放器', 'warning');
                            playIframeFallback();
                        }, { once: true });
                        renderBilibiliDirectQualityControls(thumbWrap, playDirect, actualQuality);
                        updateMinimap();
                        scheduleSaveState();
                    } catch (err) {
                        console.warn('[BiliDirect]', err);
                        if (typeof showToast === 'function') showToast('B站直连清晰度不可用，已回退到嵌入播放器', 'warning');
                        playIframeFallback();
                    }
                };

                thumbWrap.addEventListener('click', (e) => {
                    if (e.target.closest('[data-open-url]')) return;
                    if (e.target.closest('.bili-quality-controls')) return;
                    if (e.target.closest('video')) return;
                    e.stopPropagation();
                    playDirect(80);
                });

                const apiUrl = idType === 'bv'
                    ? `https://api.bilibili.com/x/web-interface/view?bvid=${videoId}`
                    : `https://api.bilibili.com/x/web-interface/view?aid=${videoId}`;
                metadataReady = fetchWithFallback(apiUrl, 5000).then(contents => {
                    const resData = typeof contents === 'string' ? JSON.parse(contents) : contents;
                    if (resData.code === 0 && resData.data) {
                        const data = resData.data;
                        const pageIndex = Math.max(0, (parseInt(page, 10) || 1) - 1);
                        biliCid = String(data.pages?.[pageIndex]?.cid || data.cid || '');
                        embedUrl = buildBiliEmbedUrl(80);
                        const frame = thumbWrap.querySelector('iframe.embedded-video-frame');
                        if (frame && biliCid && !new URL(frame.src).searchParams.get('cid')) frame.src = embedUrl;
                        if (data.pic) {
                            const cleanUrl = data.pic.replace(/^https?:\/\//, '');
                            const imgProxy = `https://images.weserv.nl/?url=${encodeURIComponent(cleanUrl)}`;
                            const cover = thumbWrap.querySelector('.bili-cover');
                            if (cover) {
                                cover.style.background = `url('${imgProxy}') center/cover no-repeat`;
                                cover.innerHTML = '';
                            }
                        }
                        metaWrap.innerHTML = `
                            <div style="padding:12px 16px;">
                                <div style="font-size:14px; font-weight:600; color:#333; -webkit-line-clamp:2; display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; line-height:1.4;">${data.title}</div>
                                <div style="margin-top:6px; font-size:12px; color:#8a94a6;"><span style="color:#00a1d6; font-weight:bold;">Bilibili</span> • ${data.owner?.name || 'UP主'}</div>
                            </div>`;
                    } else metaWrap.style.display = 'none';
                    updateMinimap(); scheduleSaveState();
                }).catch(() => metaWrap.style.display = 'none');
            }

            // 普通网页：多代理 + 优雅降级
            function renderWebCard(url, forceRefresh = false) {
                const normalizedUrl = normalizeLinkUrl(url);
                const currentClip = getLinkClipData(attached);
                if (!forceRefresh && currentClip?.contentHtml && normalizeLinkUrl(currentClip.url) === normalizedUrl) {
                    renderArticleClip(currentClip);
                    return;
                }

                setArticleClip(null);
                if (!card.classList.contains('nested-card')) { card.style.width = '520px'; card.style.height = 'auto'; }
                previewContent.innerHTML = `<div class="link-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在剪藏网页正文...</div>`;

                let hostname = getHostname(normalizedUrl);
                const favicon = `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;

                fetchWithFallback(normalizedUrl).then(payload => {
                    const html = coerceHtmlResponse(payload);
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const clip = extractReadableArticle(html, normalizedUrl);
                    if (clip?.contentHtml) {
                        renderArticleClip(clip);
                        if (typeof showToast === 'function') showToast('正文已剪藏到 Link 卡片', 'success', 1800);
                        return;
                    }

                    const title = doc.querySelector('meta[property="og:title"]')?.content
                        || doc.querySelector('meta[name="twitter:title"]')?.content
                        || doc.title?.trim()
                        || hostname;
                    const desc = doc.querySelector('meta[property="og:description"]')?.content
                        || doc.querySelector('meta[name="twitter:description"]')?.content
                        || doc.querySelector('meta[name="description"]')?.content || '';
                    let image = doc.querySelector('meta[property="og:image"]')?.content
                        || doc.querySelector('meta[name="twitter:image"]')?.content || '';
                    if (image && !image.startsWith('http')) {
                        try { image = new URL(image, url).href; } catch {}
                    }

                    previewContent.innerHTML = `
                        <div class="web-preview" style="cursor:default;">
                            ${image ? `<div class="web-preview-img" style="background-image: url(&quot;${escapeAttribute(image)}&quot;)"></div>` : ''}
                            <div class="web-preview-info">
                                <div class="web-preview-title">${escapeHtml(title)}</div>
                                ${desc ? `<div class="web-preview-desc">${escapeHtml(desc)}</div>` : ''}
                                <div class="web-preview-domain" style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; text-transform:none; letter-spacing:0;">
                                    <span style="display:flex; align-items:center; gap:6px; color:#a0aab8;">
                                        <img src="${escapeAttribute(favicon)}" style="width:14px; height:14px; border-radius:2px;" onerror="this.style.display='none'">${escapeHtml(hostname)}
                                    </span>
                                    <span data-open-url="${escapeAttribute(normalizedUrl)}" style="color:var(--primary-blue); font-size:11px; cursor:pointer; padding:4px 8px; border-radius:4px;">打开原网页 <i class="fa-solid fa-arrow-up-right-from-square"></i></span>
                                </div>
                            </div>
                        </div>
                    `;
                    updateMinimap(); scheduleSaveState();
                }).catch(() => {
                    previewContent.innerHTML = `
                        <div style="padding:18px; display:flex; gap:12px; align-items:flex-start;">
                            <img src="${escapeAttribute(favicon)}" style="width:32px; height:32px; border-radius:6px; flex-shrink:0;" onerror="this.style.display='none'">
                            <div style="flex:1; min-width:0;">
                                <div style="font-size:14px; font-weight:600; color:#333; margin-bottom:4px; word-break:break-all;">${escapeHtml(hostname)}</div>
                                <div style="font-size:12px; color:#8a94a6; margin-bottom:8px;">网页正文剪藏失败，可能是登录、反爬或动态加载限制</div>
                                <div data-open-url="${escapeAttribute(normalizedUrl)}" style="display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--primary-blue); cursor:pointer;">打开原网页 <i class="fa-solid fa-arrow-up-right-from-square"></i></div>
                            </div>
                        </div>
                    `;
                    updateMinimap(); scheduleSaveState();
                });
            }

            // 统一处理"外部打开"按钮点击（阻止冒泡到卡片拖拽）
            previewContent.addEventListener('click', (e) => {
                const refreshEl = e.target.closest('[data-refresh-clip]');
                if (refreshEl) {
                    e.stopPropagation();
                    renderWebCard(input.value, true);
                    return;
                }
                const switchEl = e.target.closest('[data-switch-embed-url]');
                if (switchEl) {
                    e.stopPropagation();
                    const frame = previewContent.querySelector('.embedded-video-frame');
                    if (frame) {
                        const switchUrl = switchEl.dataset.switchEmbedUrl;
                        frame.src = switchUrl;
                        switchEl.remove();
                    }
                    return;
                }
                const openEl = e.target.closest('[data-open-url]');
                if (openEl) {
                    e.stopPropagation();
                    openExternalUrl(openEl.dataset.openUrl);
                }
            });

            input.addEventListener('blur', () => {
                attached.classList.remove('is-editing');
                updatePreview(input.value);
            });
            input.addEventListener('input', () => {
                const clip = getLinkClipData(attached);
                if (clip && normalizeLinkUrl(clip.url) !== normalizeLinkUrl(input.value)) setArticleClip(null);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') input.blur();
            });
            // 核心修复：监听粘贴事件，如果是网络链接则自动触发解析，无需手动回车或点击空白处
            input.addEventListener('paste', (e) => {
                setTimeout(() => {
                    const val = input.value.trim();
                    if (/^https?:\/\//i.test(val)) {
                        input.blur();
                    }
                }, 50);
            });

            if (initialUrl) updatePreview(initialUrl);

            return attached;
        }

        function createTodoCard(x, y, initialHtml = "", w = 260, h = 160, isNested = false) {
            const card = document.createElement('div');
            card.className = `card todo-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = `${h}px`; }
            card.dataset.type = "todo"; card.dataset.boardId = getActiveBoard();
            card.innerHTML = `<div class="card-header"><span>To-do</span><i class="fa-solid fa-ellipsis-vertical"></i></div><div class="todo-list-wrap">${initialHtml || `<div class="todo-item"><input type="checkbox" class="todo-checkbox"><div class="todo-text" contenteditable="false">New task</div></div>`}<div class="todo-add-btn"><i class="fa-solid fa-plus"></i> Add task</div></div>`;

            const attached = attachAndReturn(card, '.todo-text');
            const wrap = attached.querySelector('.todo-list-wrap');
            wrap.addEventListener('click', (e) => {
                if (e.target.classList.contains('todo-checkbox')) e.target.closest('.todo-item').classList.toggle('done', e.target.checked);
                if (e.target.closest('.todo-add-btn')) {
                    const btn = e.target.closest('.todo-add-btn');
                    const newItem = document.createElement('div'); newItem.className = 'todo-item';
                    newItem.innerHTML = `<input type="checkbox" class="todo-checkbox"><div class="todo-text" contenteditable="true"></div>`;
                    wrap.insertBefore(newItem, btn); attached.classList.add('is-editing'); newItem.querySelector('.todo-text').focus();
                    autoGrowTodoCard(attached); // 核心注入：添加新任务时撑开高度
                }
            });
            wrap.addEventListener('keydown', (e) => {
                if (e.target.classList.contains('todo-text') && e.key === 'Enter') {
                    e.preventDefault(); attached.querySelector('.todo-add-btn').click();
                }
                // 核心极客优化：空任务按退格键直接删除整行并对齐光标
                if (e.target.classList.contains('todo-text') && e.key === 'Backspace' && e.target.textContent === '') {
                    const item = e.target.closest('.todo-item');
                    if (wrap.querySelectorAll('.todo-item').length > 1) {
                        e.preventDefault();
                        const prev = item.previousElementSibling;
                        item.remove();
                        if (prev && prev.classList.contains('todo-item')) {
                            const prevText = prev.querySelector('.todo-text');
                            prevText.focus(); placeCaretAtEnd(prevText);
                        }
                        autoGrowTodoCard(attached); // 核心注入：删除任务时收缩高度
                    }
                }
            });
            wrap.addEventListener('input', () => autoGrowTodoCard(attached)); // 核心注入：文本换行时撑开高度

            requestAnimationFrame(() => autoGrowTodoCard(attached)); // 初始化渲染时自动校准一次高度
            return attached;
        }

        function createBoardCard(x, y, initialTitle = "New Board", deepHtml = "", forceId = null, cardState = null) {
            const card = document.createElement('div');
            card.className = 'card board-card'; card.style.left = `${x}px`; card.style.top = `${y}px`;
            const boardId = forceId ? forceId : 'board-' + Date.now(); card.id = boardId;
            card.dataset.type = "board"; card.dataset.boardId = getActiveBoard();
                        card.innerHTML = `<div class="board-content"><div class="board-icon-bg"></div><div class="board-title" contenteditable="false">${initialTitle}</div><div class="board-count">0 cards</div></div>`;
            const attached = attachAndReturn(card, '.board-title');
            const titleEl = attached.querySelector('.board-title');
            
            titleEl.addEventListener('blur', () => { 
                attached.classList.remove('is-editing'); 
                titleEl.setAttribute('contenteditable', 'false'); // 确保失焦后恢复不可编辑状态
                scheduleSaveState();
            });
            // 🌟 核心修复：按回车键直接确认并退出编辑模式，而不是换行
            titleEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    titleEl.blur(); // 触发 blur 保存并退出
                }
            });

            // 核心新增：恢复旧版图标或应用用户上传的背景图，若为新建则默认授予小文件夹图标
            const iconBg = attached.querySelector('.board-icon-bg');
            if (cardState) {
                if (cardState.iconHtml) iconBg.innerHTML = cardState.iconHtml;
                if (cardState.iconBg) iconBg.style.backgroundImage = cardState.iconBg;
            } else {
                iconBg.innerHTML = '<i class="fa-solid fa-folder"></i>';
            }

            if (deepHtml && deepHtml.trim() !== '') {
                const tempDiv = document.createElement('div'); tempDiv.innerHTML = deepHtml;
                const previousStack = [...boardStack]; boardStack.push(boardId);

                Array.from(tempDiv.children).forEach(child => {
                    const type = child.dataset.type;
                    const cw = parseFloat(child.style.width) || 280, ch = parseFloat(child.style.height) || 200;
                    const cx = parseFloat(child.style.left), cy = parseFloat(child.style.top);

                    if (type === 'note') createNoteCard(cx, cy, child.querySelector('.md-editor').innerHTML, cw, ch, false, {
                        accentColor: child.style.getPropertyValue('--note-accent'),
                        backgroundColor: child.style.getPropertyValue('--note-bg')
                    });
                    else if (type === 'link') { const inputVal = child.querySelector('.link-input').getAttribute('value') || child.querySelector('.link-input').value; createLinkCard(cx, cy, inputVal); }
                    else if (type === 'todo') { const listClone = child.querySelector('.todo-list-wrap').cloneNode(true); if(listClone.querySelector('.todo-add-btn')) listClone.querySelector('.todo-add-btn').remove(); createTodoCard(cx, cy, listClone.innerHTML, cw, ch); }
                    else if (type === 'column') { const dHtml = child.querySelector('.column-drop-zone').innerHTML; createColumnCard(cx, cy, child.querySelector('.column-title').innerText, cw, ch, dHtml); }
                    else if (type === 'table') createTableCard(cx, cy, child.querySelector('.table-wrap').innerHTML, cw, ch);
                    else if (type === 'comment') createCommentCard(cx, cy, child.querySelector('.comment-list').innerHTML, cw, ch);
                    else if (type === 'image') createImageCard(cx, cy, child.querySelector('img').src, cw, ch);
                    else if (type === 'file') createFileCard(cx, cy, child.dataset.filename, child.dataset.fileType, child.dataset.fileSize, child.dataset.fileData, child.querySelector('.pdf-note-area')?.innerHTML || "", cw, ch);
                });
                boardStack = previousStack; updateAllBoardCounts(); refreshBoardVisibility();
            }
            return attached;
        }

        function createColumnCard(x, y, initialTitle = "New Column", w = 400, h = 400, deepHtml = "") {
            const card = document.createElement('div');
            card.className = 'card column-card';
            card.style.left = `${x}px`; card.style.top = `${y}px`;
            card.style.width = `${w}px`;
            card.style.height = `auto`;
            card.dataset.type = "column"; card.dataset.boardId = getActiveBoard();
            card.innerHTML = `<div class="column-header-wrap"><div class="column-title" contenteditable="false">${initialTitle}</div><i class="fa-solid fa-ellipsis" style="color: #a0aab8;"></i></div><div class="column-drop-zone"></div>`;

            const attached = attachAndReturn(card, '.column-title');
            const titleEl = attached.querySelector('.column-title');
            
            titleEl.addEventListener('blur', () => { 
                attached.classList.remove('is-editing'); 
                titleEl.setAttribute('contenteditable', 'false'); // 失焦恢复不可编辑
                scheduleSaveState();
            });
            
            // 增加：回车键确认并退出编辑模式
            titleEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    titleEl.blur(); // 触发 blur 保存并退出
                }
            });

            const dropZone = attached.querySelector('.column-drop-zone');
            columnObserver.observe(dropZone, { childList: true, subtree: true, characterData: true, attributes: true });

            if (deepHtml) {
                const tempDiv = document.createElement('div'); tempDiv.innerHTML = deepHtml;
                Array.from(tempDiv.children).forEach(child => {
                    const type = child.dataset.type;
                    if (type === 'note') dropZone.appendChild(createNoteCard(0,0, child.querySelector('.md-editor').innerHTML, 0,0, true, {
                        accentColor: child.style.getPropertyValue('--note-accent'),
                        backgroundColor: child.style.getPropertyValue('--note-bg')
                    }));
                    else if (type === 'link') { const inputVal = child.querySelector('.link-input').getAttribute('value') || child.querySelector('.link-input').value; dropZone.appendChild(createLinkCard(0,0, inputVal, true)); }
                    else if (type === 'todo') { const listClone = child.querySelector('.todo-list-wrap').cloneNode(true); if(listClone.querySelector('.todo-add-btn')) listClone.querySelector('.todo-add-btn').remove(); dropZone.appendChild(createTodoCard(0,0, listClone.innerHTML, 0,0, true)); }
                    else if (type === 'table') { dropZone.appendChild(createTableCard(0,0, child.querySelector('.table-wrap').innerHTML, 0,0, true)); }
                    else if (type === 'comment') { dropZone.appendChild(createCommentCard(0,0, child.querySelector('.comment-list').innerHTML, 0,0, true)); }
                    else if (type === 'image') { dropZone.appendChild(createImageCard(0,0, child.querySelector('img').src, 0, 'auto', true)); }
                    else if (type === 'file') { dropZone.appendChild(createFileCard(0,0, child.dataset.filename, child.dataset.fileType, child.dataset.fileSize, child.dataset.fileData, child.querySelector('.pdf-note-area')?.innerHTML || "", 0, 'auto', true)); }

                });
            }
            return attached;
        }

        function createTableCard(x, y, initialHtml = "", w = 360, h = 180, isNested=false) {
            const card = document.createElement('div');
            card.className = `card table-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = `${h}px`; }
            card.dataset.type = "table"; card.dataset.boardId = getActiveBoard();
            card.innerHTML = `<div class="card-header"><span>Table (支持公式)</span><i class="fa-solid fa-ellipsis-vertical"></i></div><div class="table-wrap">${initialHtml || `<table class="card-table"><tr><th contenteditable="false">Item</th><th contenteditable="false">Q1</th><th contenteditable="false">Q2</th></tr><tr><td contenteditable="false">A</td><td contenteditable="false">10</td><td contenteditable="false">20</td></tr><tr><td contenteditable="false">B</td><td contenteditable="false">15</td><td contenteditable="false">5</td></tr><tr><th contenteditable="false">Total</th><td contenteditable="false" data-formula="=B2+B3">30</td><td contenteditable="false" data-formula="=C2+C3">25</td></tr></table>`}</div>`;
            const attached = attachAndReturn(card, 'td, th');
            const table = attached.querySelector('table');
            table.addEventListener('blur', (e) => {
                if(e.target.tagName === 'TD' || e.target.tagName === 'TH') {
                    let text = e.target.innerText.trim();
                    if(text.startsWith('=')) { e.target.dataset.formula = text; } else { delete e.target.dataset.formula; }
                    computeTable(table);
                }
            }, true);
            computeTable(table); return attached;
        }

        function computeTable(table) {
            const data = {}; let r = 1;
            table.querySelectorAll('tr').forEach((row) => {
                let c = 0; row.querySelectorAll('td, th').forEach(cell => { const name = String.fromCharCode(65 + c) + r; data[name] = parseFloat(cell.innerText) || 0; cell.dataset.name = name; c++; }); r++;
            });
            table.querySelectorAll('td, th').forEach(cell => {
                if (cell.dataset.formula) {
                    try { let expr = cell.dataset.formula.substring(1).toUpperCase().replace(/[A-Z]\d/g, m => data[m] || 0); cell.innerText = eval(expr); } catch(e) { cell.innerText = "ERR"; }
                }
            });
        }

        // 🌟 新增：初始化 Supabase 客户端通道 (上线时请替换为你的真实配置)
        const supabaseUrl = 'YOUR_SUPABASE_URL';
        const supabaseKey = 'YOUR_SUPABASE_ANON_KEY';
        let supabaseClient = null;
        let commentChannel = null;

        if (window.supabase) {
            try {
                supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
                // 利用 Broadcast 构建零后端的临时实时广播通道
                commentChannel = supabaseClient.channel('board-comments', {
                    config: { broadcast: { self: false } }
                });

                commentChannel.on('broadcast', { event: 'new-comment' }, (payload) => {
                    const data = payload.payload;
                    const targetCard = document.getElementById(data.cardId);
                    if (targetCard) {
                        const list = targetCard.querySelector('.comment-list');
                        if (list) {
                            const now = new Date();
                            const timeStr = now.toLocaleDateString() + ' ' + now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                            const msg = document.createElement('div'); msg.className = 'comment-msg';
                            msg.innerHTML = `<div class="avatar" style="background:#607d8b;">${data.user.charAt(0).toUpperCase()}</div><div class="msg-content"><div class="msg-meta"><span class="msg-name">${data.user}</span><span class="msg-time">${timeStr}</span></div><div class="msg-text">${escapeHtml(data.text)}</div><div class="msg-reply">Reply</div></div>`;
                            list.appendChild(msg);
                            list.scrollTop = list.scrollHeight;
                            scheduleSaveState();
                        }
                    }
                }).subscribe();
            } catch (err) {
                console.warn("Supabase 尚未配置有效密钥，协作暂不可用。");
            }
        }

        function createCommentCard(x, y, initialHtml = "", w = 320, h = 240, isNested = false) {
            const card = document.createElement('div');
            // 为协作同步确保唯一标识
            if (!card.id) card.id = 'comment-' + Date.now() + Math.floor(Math.random() * 1000);
            card.className = `card comment-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = `${h}px`; }
            card.dataset.type = "comment"; card.dataset.boardId = getActiveBoard();
            card.innerHTML = `<div class="card-header"><span>Comment (协作)</span><i class="fa-solid fa-ellipsis-vertical"></i></div><div class="comment-wrap"><div class="comment-list">${initialHtml || ''}</div><div class="comment-input-box"><input type="text" placeholder="Write a reply..."><button class="comment-submit"><i class="fa-solid fa-arrow-up"></i></button></div></div>`;
            const attached = attachAndReturn(card, '.comment-input-box input');
            const input = attached.querySelector('input'), submit = attached.querySelector('.comment-submit'), list = attached.querySelector('.comment-list');

            const addComment = () => {
                const text = input.value.trim();
                if(!text) return;

                const userName = "Me";
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                const msg = document.createElement('div');
                msg.className = 'comment-msg';
                msg.innerHTML = `
                    <div class="avatar" style="background:#e91e63;">M</div>
                    <div class="msg-content">
                        <div class="msg-meta"><span class="msg-name">${userName}</span><span class="msg-time">${timeStr}</span></div>
                        <div class="msg-text">${escapeHtml(text)}</div>
                    </div>`;

                list.appendChild(msg);
                input.value = ''; // 清空输入框
                list.scrollTop = list.scrollHeight; // 自动滚动到底部

                // 确保点击发送后不会关闭弹窗
                input.focus();

                scheduleSaveState(); // 触发保存

                // 如果有协作通道，发送广播
                if (commentChannel) {
                    commentChannel.send({
                        type: 'broadcast',
                        event: 'new-comment',
                        payload: { cardId: attached.id, text: text, user: "User_" + Math.floor(Math.random()*1000) }
                    });
                }
            };

            submit.addEventListener('click', addComment);
            input.addEventListener('keydown', (e) => { if(e.key === 'Enter') addComment(); });
            input.addEventListener('blur', () => { attached.classList.remove('is-editing'); });
            return attached;
        }

        // 🌟 字幕直连抓取引擎（移植自 obsidian-clipper）
        //
        // 设计要点：
        //   1. 通过公共 CORS 代理调用 Bilibili / YouTube 公开接口，无需油猴脚本
        //   2. 每步严格校验：响应必须属于请求的那个视频，否则立即换代理（修复「抓到别的视频」BUG）
        //   3. YouTube 优先用 InnerTube POST（响应 ~100KB），失败才回退到巨大的 watch 页 HTML
        //   4. BV 号大小写敏感（Bilibili 的 base58 编码区分大小写，不能用 toLowerCase）
        //   5. 每步都有进度回调，UI 可实时反馈
        window.__TRANSCRIPT_EXTRACTOR__ = {
            parseMaybeJson(data) {
                if (typeof data === 'string') {
                    try { return JSON.parse(data); } catch { return data; }
                }
                return data;
            },
            formatTimestamp(seconds) {
                const total = Math.max(0, Math.floor(seconds));
                const h = Math.floor(total / 3600);
                const m = Math.floor((total % 3600) / 60);
                const s = total % 60;
                const pad = (n) => String(n).padStart(2, '0');
                return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
            },
            parseBilibiliUrl(url) {
                if (/^BV[\w]+$/i.test(url)) return { bvid: url, aid: null, page: 1 };
                if (/^av\d+$/i.test(url)) return { bvid: null, aid: parseInt(url.slice(2), 10), page: 1 };
                try {
                    const u = new URL(url);
                    const match = u.pathname.match(/\/video\/(BV[\w]+|av\d+)/i);
                    const raw = match ? match[1] : '';
                    const pParam = u.searchParams.get('p');
                    const page = parseInt(pParam || '1', 10);
                    return {
                        bvid: /^BV/i.test(raw) ? raw : null,
                        aid: /^av/i.test(raw) ? parseInt(raw.slice(2), 10) : null,
                        page: page > 0 ? page : 1,
                    };
                } catch {
                    const bvMatch = url.match(/(BV[\w]+)/i);
                    if (bvMatch) return { bvid: bvMatch[1], aid: null, page: 1 };
                    return { bvid: null, aid: null, page: 1 };
                }
            },
            selectBilibiliTrack(tracks) {
                if (!Array.isArray(tracks) || !tracks.length) return null;
                const score = (t) => {
                    const lang = `${t.lan || ''} ${t.lan_doc || ''}`.toLowerCase();
                    if (lang.includes('zh-cn') || lang.includes('中文') || lang.includes('汉语')) return 5;
                    if (lang.includes('zh-hans') || lang.includes('简体')) return 4;
                    if (lang.includes('zh')) return 3;
                    if (lang.includes('en') || lang.includes('english')) return 2;
                    return 1;
                };
                return [...tracks].sort((a, b) => score(b) - score(a))[0] || null;
            },
            normalizeSubtitleUrl(u) {
                if (!u) return '';
                if (u.startsWith('//')) return `https:${u}`;
                return u;
            },
            // ----- 代理与校验抓取 -----
            // 所有公共 CORS 代理。顺序按「支持 POST / 速度 / 稳定性」排。
            // corsproxy.io 放第一是因为它同时支持 GET + POST；其他三个只能 GET。
            GET_PROXIES: [
                u => u, // 🌟 桌面端特权：优先使用本机直连抓取！
                u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
                u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}&_cb=${Date.now()}`,
                u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
                u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}&_cb=${Date.now()}`,
            ],
            // YouTube 的 POST 请求也不需要代理了：
            POST_PROXY: u => u,

            /**
             * 带校验的 GET 抓取。validator 返回真值才算成功，否则视为该代理吐回了错内容 / 被墙页，自动换下一家代理。
             * @returns {*} validator 返回的结果
             */
            async fetchGet(targetUrl, validator, timeout = 20000, label = '请求') {
                const errors = [];
                for (const makeProxy of this.GET_PROXIES) {
                    const proxyUrl = makeProxy(targetUrl);
                    const proxyHost = (new URL(proxyUrl)).host;
                    try {
                        const ctrl = new AbortController();
                        const tid = setTimeout(() => ctrl.abort(), timeout);
                        const headers = {};
                        // 注入登录态 Cookie：仅直连时附加（代理 URL 会剥离自定义 Header）
                        if (proxyUrl === targetUrl) {
                            if (/bilibili\.com/i.test(targetUrl)) {
                                const ck = localStorage.getItem('bilibili_cookie');
                                if (ck) headers['Cookie'] = ck;
                            } else if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
                                const ck = localStorage.getItem('youtube_cookie');
                                if (ck) headers['Cookie'] = ck;
                            }
                        }
                        const res = await fetch(proxyUrl, { signal: ctrl.signal, cache: 'no-store', headers: Object.keys(headers).length ? headers : undefined });
                        clearTimeout(tid);
                        if (!res.ok) { errors.push(`${proxyHost}: HTTP ${res.status}`); continue; }
                        let txt = await res.text();
                        if (!txt) { errors.push(`${proxyHost}: 空响应`); continue; }
                        // 解包 allorigins /get 的 {contents,status} 包装
                        try {
                            const wrap = JSON.parse(txt);
                            if (wrap && typeof wrap === 'object' && typeof wrap.contents === 'string') {
                                txt = wrap.contents;
                            }
                        } catch { /* 非 JSON 包装，原样使用 */ }
                        try {
                            const ok = validator(txt);
                            if (ok !== null && ok !== undefined && ok !== false) {
                                console.log(`[Caption] ✓ ${label} via ${proxyHost}`);
                                return ok;
                            }
                            errors.push(`${proxyHost}: 响应未通过校验（错视频/被墙/空字段）`);
                        } catch (ve) {
                            errors.push(`${proxyHost}: 校验异常 ${ve.message || ve}`);
                        }
                    } catch (e) {
                        errors.push(`${proxyHost}: ${e.name === 'AbortError' ? '超时' : (e.message || e)}`);
                    }
                }
                throw new Error(`${label} 全部代理均失败 [${errors.join(' | ')}]`);
            },

            /** POST 仅 corsproxy.io 支持。用于 YouTube InnerTube。 */
            async fetchPost(targetUrl, body, validator, timeout = 15000, label = 'POST') {
                const proxyUrl = this.POST_PROXY(targetUrl);
                const ctrl = new AbortController();
                const tid = setTimeout(() => ctrl.abort(), timeout);
                try {
                    const res = await fetch(proxyUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        signal: ctrl.signal,
                        cache: 'no-store'
                    });
                    clearTimeout(tid);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const txt = await res.text();
                    if (!txt) throw new Error('空响应');
                    const ok = validator(txt);
                    if (ok === null || ok === undefined || ok === false) throw new Error('响应未通过校验');
                    console.log(`[Caption] ✓ ${label} via corsproxy.io POST`);
                    return ok;
                } catch (e) {
                    clearTimeout(tid);
                    throw new Error(`${label} 失败: ${e.name === 'AbortError' ? '超时' : (e.message || e)}`);
                }
            },

            // ----- Bilibili -----
            async extractBilibili(url, onProgress = () => {}) {
                const parsed = this.parseBilibiliUrl(url);
                if (!parsed.bvid && !parsed.aid) {
                    throw new Error('无法识别 B站 视频 ID（仅支持 /video/BVxxx 或 /video/avNNN，番剧/直播不支持）');
                }

                onProgress('①/③ 获取视频基本信息...');
                const viewQS = parsed.bvid ? `bvid=${parsed.bvid}` : `aid=${parsed.aid}`;
                const viewUrl = `https://api.bilibili.com/x/web-interface/view?${viewQS}`;

                // 关键修复：BV 号大小写敏感（base58 编码），用严格相等；且必须有 bvid 字段
                const data = await this.fetchGet(viewUrl, (content) => {
                    let j;
                    try { j = JSON.parse(content); } catch { return null; }
                    if (!j || typeof j !== 'object') return null;
                    if (j.code !== 0 || !j.data || typeof j.data !== 'object') return null;
                    // 严格校验：请求的 BV 必须与响应完全一致
                    if (parsed.bvid) {
                        if (!j.data.bvid || String(j.data.bvid) !== parsed.bvid) return null;
                    }
                    if (parsed.aid) {
                        if (!j.data.aid || Number(j.data.aid) !== parsed.aid) return null;
                    }
                    return j.data;
                }, 15000, 'B站 view 接口');

                const pages = Array.isArray(data.pages) ? data.pages : [];
                const matchedPage = pages.find(p => p.page === parsed.page) || pages[parsed.page - 1];
                const cid = matchedPage?.cid ?? data.cid;
                if (!cid) throw new Error('视频信息完整但缺少 cid，无法继续');

                onProgress('②/③ 获取字幕轨道列表...');
                const playerQS = new URLSearchParams();
                playerQS.set('cid', String(cid));
                if (data.bvid || parsed.bvid) playerQS.set('bvid', data.bvid || parsed.bvid);
                if (data.aid || parsed.aid) playerQS.set('aid', String(data.aid || parsed.aid));
                const playerUrl = `https://api.bilibili.com/x/player/v2?${playerQS.toString()}`;

                // player/v2 有时被墙，失败不算致命，继续用空字幕列表
                const playerData = await this.fetchGet(playerUrl, (content) => {
                    let j;
                    try { j = JSON.parse(content); } catch { return null; }
                    if (!j || typeof j !== 'object' || j.code !== 0 || !j.data) return null;
                    return j.data;
                }, 15000, 'B站 player 接口').catch(e => {
                    console.warn('[Caption] player/v2 失败，使用空字幕列表:', e.message);
                    return null;
                });

                const tracks = playerData?.subtitle?.subtitles || [];
                const selected = this.selectBilibiliTrack(tracks);
                if (!selected?.subtitle_url) {
                    throw new Error(`[真空]《${data.title || '该视频'}》无 CC 字幕或 AI 字幕`);
                }

                onProgress(`③/③ 下载「${selected.lan_doc || selected.lan || '字幕'}」...`);
                const body = await this.fetchGet(
                    this.normalizeSubtitleUrl(selected.subtitle_url),
                    (content) => {
                        let j;
                        try { j = JSON.parse(content); } catch { return null; }
                        if (!j || !Array.isArray(j.body)) return null;
                        return j.body;
                    },
                    15000,
                    'B站字幕文件'
                );

                const lines = body
                    .filter(c => typeof c.from === 'number' && typeof c.content === 'string')
                    .map(c => ({
                        time: this.formatTimestamp(c.from),
                        text: String(c.content).replace(/\s+/g, ' ').trim()
                    }))
                    .filter(c => c.text.length > 0);

                if (lines.length === 0) throw new Error('字幕文件下载成功但内容为空');
                return lines;
            },
            parseYoutubeId(url) {
                try {
                    const u = new URL(url);
                    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
                    if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0];
                    return u.searchParams.get('v') || null;
                } catch {
                    return null;
                }
            },
            extractInlineJson(html, globalName) {
                const needle = html.indexOf(globalName);
                if (needle === -1) return null;
                const start = html.indexOf('{', needle);
                if (start === -1) return null;
                let depth = 0, inStr = false, strCh = '', escape = false;
                for (let i = start; i < html.length; i++) {
                    const ch = html[i];
                    if (inStr) {
                        if (escape) { escape = false; continue; }
                        if (ch === '\\') { escape = true; continue; }
                        if (ch === strCh) inStr = false;
                        continue;
                    }
                    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            try { return JSON.parse(html.slice(start, i + 1)); }
                            catch { return null; }
                        }
                    }
                }
                return null;
            },
            pickYoutubeCaptionTrack(tracks) {
                if (!Array.isArray(tracks) || !tracks.length) return null;
                const score = (t) => {
                    const code = (t.languageCode || '').toLowerCase();
                    const nonAsr = t.kind !== 'asr' ? 10 : 0;
                    if (code === 'zh-cn' || code === 'zh') return nonAsr + 5;
                    if (code.startsWith('zh')) return nonAsr + 4;
                    if (code === 'en' || code.startsWith('en')) return nonAsr + 3;
                    return nonAsr + 1;
                };
                return [...tracks].sort((a, b) => score(b) - score(a))[0] || null;
            },
            decodeEntities(text) {
                return text
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&apos;/g, "'")
                    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
                    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
            },
            parseYoutubeXml(xml) {
                const segs = [];
                // srv3 格式：<p t="ms" d="ms"><s>word</s>...</p>
                const pRegex = /<p\s+t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
                let m;
                while ((m = pRegex.exec(xml)) !== null) {
                    const startMs = parseInt(m[1], 10);
                    let text = '';
                    const sRegex = /<s[^>]*>([^<]*)<\/s>/g;
                    let sm;
                    while ((sm = sRegex.exec(m[2])) !== null) text += sm[1];
                    if (!text) text = m[2].replace(/<[^>]+>/g, '');
                    text = this.decodeEntities(text).replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
                    if (text) segs.push({ start: startMs / 1000, text });
                }
                // 简单格式回退：<text start="s" dur="s">content</text>
                if (segs.length === 0) {
                    const textRegex = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
                    while ((m = textRegex.exec(xml)) !== null) {
                        const start = parseFloat(m[1]);
                        const text = this.decodeEntities(m[2].replace(/<[^>]+>/g, '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')).trim();
                        if (text) segs.push({ start, text });
                    }
                }
                return segs;
            },
            async extractYoutube(url) {
                const videoId = this.parseYoutubeId(url);
                if (!videoId) throw new Error('无法识别 YouTube 视频 ID');

                const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=zh-CN`;

                // 关键修复：校验 HTML 必须包含 ytInitialPlayerResponse 且能解析出当前视频，
                // 过滤代理返回的空白页 / 反爬页 / 错视频
                const playerResponse = await this.fetchGet(watchUrl, (content) => {
                    const str = typeof content === 'string' ? content : '';
                    if (!str || !str.includes('ytInitialPlayerResponse')) return null;
                    const resp = this.extractInlineJson(str, 'ytInitialPlayerResponse');
                    if (!resp) return null;
                    const respVid = resp?.videoDetails?.videoId
                        || resp?.microformat?.playerMicroformatRenderer?.externalVideoId;
                    if (respVid && respVid !== videoId) return null;
                    return resp;
                }, 20000, 'YouTube watch页');

                const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('[真空]');

                const track = this.pickYoutubeCaptionTrack(tracks);
                if (!track?.baseUrl) throw new Error('[真空]');

                const xml = await this.fetchGet(track.baseUrl, (content) => {
                    const str = typeof content === 'string' ? content : '';
                    if (!str) return null;
                    if (!str.includes('<text') && !str.includes('<p')) return null;
                    return str;
                }, 15000, 'YouTube字幕文件');

                const segs = this.parseYoutubeXml(xml);
                if (segs.length === 0) throw new Error('YouTube 字幕格式解析失败');

                return segs.map(s => ({
                    time: this.formatTimestamp(s.start),
                    text: s.text
                }));
            },
            async extract(url) {
                if (/youtube\.com|youtu\.be/i.test(url)) {
                    return this.extractYoutube(url);
                }
                if (/bilibili\.com|b23\.tv/i.test(url) || /^BV[\w]+/i.test(url) || /bvid=BV[\w]+/i.test(url)) {
                    return this.extractBilibili(url);
                }
                throw new Error('当前链接类型不支持直接提取');
            }
        };

        function createCaptionCard(x, y, initialUrl = "", w = 380, h = 460, isNested = false) {
            const card = document.createElement('div');
            card.className = `card caption-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = `${h}px`; }
            card.dataset.type = "caption"; card.dataset.boardId = getActiveBoard();

            card.innerHTML = `
                <div class="card-header">
                    <span>💬 Transcript</span>
                    <div style="display:flex; gap:12px; align-items:center;">
                        <i class="fa-regular fa-copy caption-copy-btn" title="一键复制纯文本" style="cursor:pointer; color:var(--primary-blue); font-size:14px;"></i>
                        <i class="fa-solid fa-ellipsis-vertical"></i>
                    </div>
                </div>
                <div class="caption-header-input">
                    <input type="text" placeholder="粘贴 B站/YT URL 提取..." value="${initialUrl}">
                    <button><i class="fa-solid fa-bolt"></i> 提取</button>
                </div>
                <div class="caption-list">
                    <div class="caption-item"><div class="caption-time">00:00</div><div class="caption-text" contenteditable="false">在这里记录视频的文字稿...</div></div>
                </div>
            `;

            const attached = attachAndReturn(card, '.caption-text, .caption-header-input input');
            const input = attached.querySelector('input');
            const btn = attached.querySelector('button');
            const list = attached.querySelector('.caption-list');

            const fetchSubtitles = async () => {
                const url = input.value.trim();
                if (!url) return;

                // 直连优先：通过 CORS 代理调用 Bilibili / YouTube 公共接口，无需油猴脚本
                list.innerHTML = `
                    <div style="text-align:center; padding:40px 20px; color:#5b82fb;">
                        <i class="fa-solid fa-spinner fa-spin" style="font-size: 28px; margin-bottom: 15px;"></i>
                        <div style="font-weight:bold; font-size:14px;">正在直连抓取字幕...</div>
                        <div style="font-size:12px; margin-top:6px; opacity:0.8;">通过公开接口解析 CC / AI 字幕</div>
                    </div>`;

                try {
                    const lines = await window.__TRANSCRIPT_EXTRACTOR__.extract(url);
                    if (!lines || lines.length === 0) throw new Error('未提取到有效字幕');

                    const html = lines.map(line => `
                        <div class="caption-item">
                            <div class="caption-time">${line.time}</div>
                            <div class="caption-text" contenteditable="true">${escapeHtml(line.text)}</div>
                        </div>`).join('');
                    list.innerHTML = html;
                    scheduleSaveState();
                    if (typeof showToast === 'function') showToast(`✅ 直连提取成功！共 ${lines.length} 条字幕`, 'success');
                    return;
                } catch (err) {
                    console.warn('[Caption] 直连提取失败:', err);

                    const rawMsg = (err && err.message) ? err.message : '未知错误';
                    let displayMsg = rawMsg;
                    let color = '#ef4444';
                    if (rawMsg.includes('[真空]')) {
                        displayMsg = '该视频未提供任何 CC / AI 字幕轨道。';
                        color = '#f59e0b';
                    }
                    list.innerHTML = `<div style="padding:20px; color:${color}; line-height:1.5;">❌ 字幕提取失败：<br>${escapeHtml(displayMsg)}</div>`;
                }
            };

            btn.addEventListener('click', fetchSubtitles);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchSubtitles(); });

            // 监听文字编辑保存状态
            list.addEventListener('blur', (e) => {
                if(e.target.classList.contains('caption-text')) scheduleSaveState();
            }, true);

            // 🌟 核心新增：一键复制纯文本功能（绑定在 header 的复制图标上）
            const copyBtn = card.querySelector('.caption-copy-btn');
            if (copyBtn) {
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const texts = Array.from(list.querySelectorAll('.caption-text'))
                                      .map(el => el.innerText.trim())
                                      .filter(text => text.length > 0);
                    if (texts.length === 0) {
                        if (typeof showToast === 'function') showToast('⚠️ 暂无有效字幕可复制', 'warning');
                        return;
                    }
                    const plainText = texts.join('\n');
                    navigator.clipboard.writeText(plainText).then(() => {
                        if (typeof showToast === 'function') showToast('✅ 纯文本复制成功！', 'success');
                    }).catch(() => {
                        if (typeof showToast === 'function') showToast('❌ 复制失败，请检查剪贴板权限', 'error');
                    });
                });
            }

            // 🌟 核心修复：点击时间戳，精准反向控制 Link 视频空降（完美兼容 YouTube 和 B站分P）
            list.addEventListener('click', (e) => {
                if (e.target.classList.contains('caption-time')) {
                    const timeStr = e.target.innerText;
                    const parts = timeStr.split(':').reverse();
                    let seconds = 0;
                    for (let i = 0; i < parts.length; i++) seconds += parseInt(parts[i]) * Math.pow(60, i);

                    const url = input.value.trim();

                    // 采用与底端探针完全一致的“全球通杀提取逻辑”，确保身份 ID 绝对一致
                    let targetId = null;
                    if (url.includes('youtu')) {
                        const ytMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/i);
                        targetId = ytMatch ? ytMatch[1] : null;
                    } else {
                        const biliMatch = url.match(/(?:bvid=|video\/|bilibili\.com\/|b23\.tv\/)(BV\w+)/i) || url.match(/^(BV\w+)/i);
                        const targetBvid = biliMatch ? biliMatch[1] : null;
                        if (targetBvid) {
                            const pMatch = url.match(/[?&]p=(\d+)/i);
                            const p = pMatch ? pMatch[1] : '1';
                            targetId = `${targetBvid}_p${p}`;
                        }
                    }

                    if (targetId) {
                        // 向 Link 卡片内的播放器 iframe 发送跳转指令
                        document.querySelectorAll('.link-card iframe, .link-card webview').forEach(player => {
                            const src = player.src;
                            try {
                                // YouTube: 使用官方 iframe API postMessage
                                if ((/youtube(?:-nocookie)?\.com/i.test(src) || /youtube-player\.html/i.test(src)) && player.tagName !== 'WEBVIEW') {
                                    player.contentWindow.postMessage(JSON.stringify({
                                        event: 'command',
                                        func: 'seekTo',
                                        args: [seconds, true]
                                    }), '*');
                                }
                                // B站: 重设 src 附加时间参数 (B站 player 支持 t= 参数)
                                else if (src.includes('bilibili.com')) {
                                    const url = new URL(src);
                                    url.searchParams.set('t', String(seconds));
                                    if (player.tagName === 'WEBVIEW' && typeof player.loadURL === 'function') {
                                        player.loadURL(url.toString());
                                    } else {
                                        player.src = url.toString();
                                    }
                                }
                            } catch (e) {
                                console.warn('[Caption] 跳转失败:', e);
                            }
                        });
                    }
                }
            });

            // 核心新增：拦截粘贴事件，完美解析油猴脚本提取的 "MM:SS 内容" 格式
            list.addEventListener('paste', (e) => {
                const text = (e.originalEvent || e).clipboardData.getData('text/plain');
                if (!text) return;

                // 嗅探是否为油猴脚本的特有格式 (如 "01:23 字幕内容")
                if (/^\d{2}:\d{2}\s+/m.test(text)) {
                    e.preventDefault(); // 拦截默认的纯文本粘贴，接管解析逻辑

                    const lines = text.trim().split('\n');
                    let newHtml = '';

                    lines.forEach(line => {
                        // 匹配 MM:SS 与对应字幕内容
                        const match = line.trim().match(/^(\d{2}:\d{2})\s+(.*)/);
                        if (match) {
                            newHtml += `
                                <div class="caption-item">
                                    <div class="caption-time">${match[1]}</div>
                                    <div class="caption-text" contenteditable="true">${escapeHtml(match[2] || '')}</div>
                                </div>`;
                        }
                    });

                    if (newHtml) {
                        // 检查当前列表是否只有默认的占位提示文本
                        const firstText = list.querySelector('.caption-text');
                        if (list.children.length === 1 && firstText && firstText.innerText.includes('在这里记录视频的文字稿')) {
                            list.innerHTML = newHtml;
                        } else {
                            // 否则追加到光标所在的 item 之后
                            const currentItem = e.target.closest('.caption-item');
                            if (currentItem) {
                                currentItem.insertAdjacentHTML('afterend', newHtml);
                                // 如果当前行是空的，顺手删掉避免留白
                                if (!currentItem.querySelector('.caption-text').innerText.trim()) {
                                    currentItem.remove();
                                }
                            } else {
                                list.insertAdjacentHTML('beforeend', newHtml);
                            }
                        }
                        scheduleSaveState();
                        if (typeof showToast === 'function') showToast('✅ 劫持字幕解析并导入成功！', 'success');
                    }
                }
            });

            return attached;
        }

        // 🌟 核心新增：Excalidraw 同款智能图像压缩引擎
        function compressImage(fileOrData, callback) {
            // 如果是 GIF 动图则不压缩，保留动画
            if (fileOrData.type === 'image/gif') {
                const reader = new FileReader();
                reader.onload = e => callback(e.target.result);
                reader.readAsDataURL(fileOrData);
                return;
            }

            const maxDim = 1600; // 限制最大长宽为 1600px，保证清晰度的同时大幅减小体积
            const quality = 0.75; // 压缩质量 75%
            const img = new Image();

            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                    else { w = Math.round((w * maxDim) / h); h = maxDim; }
                }
                const cvs = document.createElement('canvas');
                cvs.width = w; cvs.height = h;
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                // 强制输出为极高压缩比的 webp 或 jpeg 格式
                callback(cvs.toDataURL('image/webp', quality));
            };

            if (typeof fileOrData === 'string') {
                img.src = fileOrData;
            } else {
                const reader = new FileReader();
                reader.onload = e => img.src = e.target.result;
                reader.readAsDataURL(fileOrData);
            }
        }

        function createImageCard(x, y, src, w = 300, h = 'auto', isNested = false) {
            const card = document.createElement('div');
            card.className = `card image-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) {
                card.style.left = `${x}px`; card.style.top = `${y}px`;
                card.style.width = `${w}px`; card.style.height = `auto`;
            }
            card.dataset.type = "image"; card.dataset.boardId = getActiveBoard();
            card.innerHTML = `<div class="card-header"><span>Image</span><i class="fa-solid fa-ellipsis-vertical"></i></div><img src="${src}" alt="pasted image">`;
            const attached = attachAndReturn(card, null);
            attached.querySelector('img').onload = () => updateMinimap();
            return attached;
        }

        function formatFileSize(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'], i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        // 核心新增：万能文件卡片生成器
        function createFileCard(x, y, filename, fileType, fileSize, dataUrl, noteHtml = "", w = 320, h = 'auto', isNested = false) {
            const card = document.createElement('div');
            card.className = `card file-card ${isNested ? 'nested-card' : ''}`;
            if(!isNested) { card.style.left = `${x}px`; card.style.top = `${y}px`; card.style.width = `${w}px`; card.style.height = h === 'auto' ? 'auto' : `${h}px`; }
            card.dataset.type = "file"; card.dataset.boardId = getActiveBoard();

            // 附件信息持久化存储
            card.dataset.filename = escapeAttribute(filename);
            card.dataset.fileType = escapeAttribute(fileType);
            card.dataset.fileSize = fileSize;
            card.dataset.fileData = dataUrl;

            let previewHtml = ''; let iconClass = 'fa-file'; let iconColor = 'var(--primary-blue)';

            // 🌟 核心修复：兼容 Windows 下丢失 MIME 类型的 PDF 识别
            const isPdfMode = fileType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
            const isHtmlMode = fileType === 'text/html' || /\.(html?|xhtml)$/i.test(filename.toLowerCase());

            // 智能格式推断引擎
            if (fileType.startsWith('video/')) {
                previewHtml = `<video controls src="${dataUrl}"></video>`; iconClass = 'fa-file-video'; iconColor = '#9c27b0';
            } else if (fileType.startsWith('audio/')) {
                previewHtml = `<audio controls src="${dataUrl}"></audio>`; iconClass = 'fa-file-audio'; iconColor = '#4caf50';
            } else if (isPdfMode) {
                previewHtml = `<iframe class="pdf-viewer" src="${dataUrl}#toolbar=0&navpanes=0"></iframe>`; iconClass = 'fa-file-pdf'; iconColor = '#ef4444';
            } else if (isHtmlMode) {
                previewHtml = `<iframe class="html-viewer" src="${dataUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>`; iconClass = 'fa-file-code'; iconColor = '#0ea5e9';
            } else if (filename.endsWith('.zip') || filename.endsWith('.rar')) {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file-zipper"></i></div>`; iconClass = 'fa-file-zipper'; iconColor = '#f59e0b';
            } else if (filename.endsWith('.doc') || filename.endsWith('.docx')) {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file-word"></i></div>`; iconClass = 'fa-file-word'; iconColor = '#2563eb';
            } else if (filename.endsWith('.xls') || filename.endsWith('.xlsx') || filename.endsWith('.csv')) {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file-excel"></i></div>`; iconClass = 'fa-file-excel'; iconColor = '#16a34a';
            } else if (filename.endsWith('.ppt') || filename.endsWith('.pptx')) {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file-powerpoint"></i></div>`; iconClass = 'fa-file-powerpoint'; iconColor = '#ea580c';
            } else if (fileType.startsWith('text/') || filename.endsWith('.md') || filename.endsWith('.json') || filename.endsWith('.js') || filename.endsWith('.html')) {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file-code"></i></div>`; iconClass = 'fa-file-code'; iconColor = '#475569';
            } else {
                previewHtml = `<div class="generic-file-icon"><i class="fa-solid fa-file"></i></div>`;
            }

            // PDF 专属伴读模式
            const noteAreaHtml = isPdfMode ? `<div class="pdf-note-area" contenteditable="false">${noteHtml}</div>` : '';

            card.innerHTML = `
                <div class="card-header" style="position: absolute; width: 100%; top:0; z-index: 10; opacity:0; transition: opacity 0.2s; background: rgba(255,255,255,0.8); padding: 6px 12px; border:none;"><span>${isPdfMode ? '📖 PDF Reader' : 'File'}</span><i class="fa-solid fa-ellipsis-vertical"></i></div>
                <div class="file-preview">${previewHtml}</div>
                <div class="file-meta">
                    <div class="file-meta-icon" style="color: ${iconColor}; background: ${iconColor}15;"><i class="fa-solid ${iconClass}"></i></div>
                    <div class="file-meta-info">
                        <div class="file-name" title="${filename}">${filename}</div>
                        <div class="file-size">${formatFileSize(fileSize)}</div>
                    </div>
                    <a href="${dataUrl}" download="${filename}" class="file-download-btn" style="color:var(--text-secondary); cursor:pointer; padding:8px;"><i class="fa-solid fa-cloud-arrow-down"></i></a>
                </div>
                ${noteAreaHtml}
            `;

            // 附加事件：PDF 伴读笔记区的可编辑化
            const attached = attachAndReturn(card, isPdfMode ? '.pdf-note-area' : null);
            if (isPdfMode) {
                const noteArea = attached.querySelector('.pdf-note-area');
                noteArea.addEventListener('blur', () => attached.classList.remove('is-editing'));
                attached.addEventListener('dblclick', (e) => {
                    if (e.target === noteArea) { e.stopPropagation(); noteArea.setAttribute('contenteditable', 'true'); noteArea.focus(); attached.classList.add('is-editing'); }
                });
            }
            attached.addEventListener('mouseenter', () => attached.querySelector('.card-header').style.opacity = '1');
            attached.addEventListener('mouseleave', () => attached.querySelector('.card-header').style.opacity = '0');

            return attached;
        }

        // ================= 4. 状态与剪贴板与拖放逻辑 =================
        function attachPersistenceEvents(card) {
            if (card.__hasPersistenceEvents) return;
            card.__hasPersistenceEvents = true;
            card.addEventListener('input', (e) => { if (e.target.classList.contains('link-input')) scheduleSaveState(); });
            card.addEventListener('change', (e) => { if (e.target.classList.contains('todo-checkbox')) scheduleSaveState(); });
        }

        let pendingSaveIsObserverOnly = true;

        function scheduleSaveState(_observerSaveOnly = false) {
            if (isRestoringState || isUndoRedoing) return;

            if (Date.now() - lastRestoreTime < 1000) return;

            // 如果有任何一次调用是非观察者（即用户主动操作），则整个防抖周期的操作被标记为主动操作
            if (!_observerSaveOnly) {
                pendingSaveIsObserverOnly = false;
            }

            clearTimeout(saveStateTimer);
            saveStateTimer = setTimeout(() => {
                if (isRestoringState || isUndoRedoing) {
                    pendingSaveIsObserverOnly = true;
                    return;
                }
                saveWorkspaceState(pendingSaveIsObserverOnly);
                pendingSaveIsObserverOnly = true; // 状态复位
            }, 180);
        }

        // 用于精准比对内容变化的剥离函数（剔除视野、最后修改时间等UI级变动）
        function stripForUndo(stateObj) {
            if (!stateObj) return "";
            const copy = JSON.parse(JSON.stringify(stateObj));
            delete copy.view;
            const stripCards = (cards) => {
                if (!cards) return;
                cards.forEach(c => {
                    delete c.lastModified;
                    if (c.children) stripCards(c.children);
                });
            }
            stripCards(copy.cards);
            return JSON.stringify(copy);
        }

        function saveWorkspaceState(isObserverOnly = false) {
            if (isRestoringState || isUndoRedoing) return;
            try {
                const state = {
                    version: 1,
                    boardStack: [...boardStack],
                    view: { panX, panY, scale, minimapUserZoom },
                    cards: getRootCardsForPersistence().map(card => serializeCard(card, false)),
                    lines: lines,
                    drawData: document.getElementById('drawLayer') ? document.getElementById('drawLayer').innerHTML : ''
                };
                const newStateStr = JSON.stringify(state);

                if (!currentStateStr) {
                    currentStateStr = newStateStr;
                    localStorage.setItem(STORAGE_KEY, newStateStr);
                    if (window.noteboardSync?.queueUpload) window.noteboardSync.queueUpload();
                    return;
                }

                // 核心控制：只有主动操作，且内容真正发生变动时，才推入撤销栈
                if (!isObserverOnly) {
                    const oldStripped = stripForUndo(JSON.parse(currentStateStr));
                    const newStripped = stripForUndo(state);

                    if (oldStripped !== newStripped) {
                        undoStack.push(currentStateStr);
                        if (undoStack.length > MAX_HISTORY) undoStack.shift();
                        redoStack = [];
                    }
                }

                currentStateStr = newStateStr;
                localStorage.setItem(STORAGE_KEY, newStateStr);
                if (window.noteboardSync?.queueUpload) window.noteboardSync.queueUpload();
            } catch (error) { console.error('保存白板状态失败：', error); }
        }

        function restoreWorkspaceState() {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            try {
                const state = JSON.parse(raw);
                if (!state || !Array.isArray(state.cards)) { localStorage.removeItem(STORAGE_KEY); return false; }
                isRestoringState = true; clearTimeout(saveStateTimer);

                // 核心修复1：切断 DOM 变动监听器，防止它捕捉到恢复卡片的动作并死循环保存
                if (typeof persistenceObserver !== 'undefined') persistenceObserver.disconnect();

                // 核心修复2：给 body 加上静音动画的 class，消除刷新一样的闪烁感
                document.body.classList.add('is-restoring');

                clearWorkspaceCards();
                lines = state.lines || [];

                // 恢复手绘图层渲染数据
                if (state.drawData) {
                    const dl = document.getElementById('drawLayer');
                    if (dl) dl.innerHTML = state.drawData;
                }

                state.cards.forEach(cardState => restoreCardFromState(cardState, null));

                // 🌟 核心新增：在所有卡片恢复后，将依附型评论卡片重新绑定为弹窗标注
                document.querySelectorAll('.comment-card[data-parent-card-id]').forEach(commentCard => {
                    const parentId = commentCard.dataset.parentCardId;
                    const parentCard = document.getElementById(parentId);
                    if (parentCard) {
                        commentCard.classList.add('comment-popover-mode');
                        ensureCommentBadge(parentCard, commentCard);
                    } else {
                        // 如果父卡片意外丢失，则降级为普通游离卡片
                        commentCard.classList.remove('comment-popover-mode');
                        delete commentCard.dataset.parentCardId;
                    }
                });

                restoreViewState(state);

                        // 等待浏览器将 DOM 渲染完成后，解除动画静音并重新挂载监听器
        setTimeout(() => {
            renderLines();
            if (typeof persistenceObserver !== 'undefined') {
                persistenceObserver.observe(canvas, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-board-id', 'src'] });
            }
            document.body.classList.remove('is-restoring'); // 修复：补充解除动画静音
            lastRestoreTime = Date.now(); // 记录本次恢复的时间戳，启动 1 秒冷却期
            isRestoringState = false;
        }, 50);

                if (!isUndoRedoing) currentStateStr = raw;

                return true;
            } catch (error) {
                console.error('恢复白板状态失败：', error); localStorage.removeItem(STORAGE_KEY); isRestoringState = false; return false;
            }
        }

        function clearWorkspaceCards() { Array.from(canvas.querySelectorAll('.card')).forEach(card => card.remove()); }
        function getRootCardsForPersistence() { return Array.from(canvas.children).filter(child => child.classList && child.classList.contains('card')); }

        function restoreViewState(state) {
            const boardIds = new Set(state.cards.filter(card => card.type === 'board' && card.id).map(card => card.id));
            const nextStack = [ROOT_BOARD_ID];
            if (Array.isArray(state.boardStack)) {
                state.boardStack.forEach((boardId, index) => {
                    if (index === 0) return;
                    if (boardIds.has(boardId) && !nextStack.includes(boardId)) nextStack.push(boardId);
                });
            }
                                    boardStack = nextStack;
            // 🌟 核心修复：撤销/重做时，绝对不覆盖当前的缩放和视野位置
            if (state.view && !isUndoRedoing) {
                panX = Number.isFinite(state.view.panX) ? state.view.panX : panX; panY = Number.isFinite(state.view.panY) ? state.view.panY : panY;
                scale = Number.isFinite(state.view.scale) ? state.view.scale : scale; minimapUserZoom = Number.isFinite(state.view.minimapUserZoom) ? state.view.minimapUserZoom : minimapUserZoom;
            }
            updateBreadcrumbs();
            refreshBoardVisibility(); applyTransform();
        }

        function restoreCardFromState(cardState, parentColumn) {
            if (!cardState || !cardState.type) return null;
            const card = createCardFromState(cardState, !!parentColumn);
            if (!card) return null;


            // 核心修复：直接从行内彻底剥夺卡片初始化的弹出动画，实现无缝瞬间切换，消除闪烁刷新感
            card.style.animation = 'none';
            card.style.transition = 'none';
            setTimeout(() => { card.style.transition = ''; }, 100);

            card.dataset.boardId = cardState.boardId || ROOT_BOARD_ID;
            if (cardState.id && card.dataset.type !== 'board') card.id = cardState.id;

            // 🌟 核心新增：读取并恢复卡片的审查时间
            if (cardState.lastModified) card.dataset.lastModified = cardState.lastModified;

            if (parentColumn) {
                applyNestedCardLayout(card); parentColumn.querySelector('.column-drop-zone').appendChild(card);
            } else {
                applyRootCardLayout(card, cardState);
            }
            if (cardState.type === 'note') {
                applyNoteAppearance(card, cardState.accentColor, cardState.backgroundColor); autoGrowNoteCard(card);
            }
            if (cardState.type === 'todo') {
                autoGrowTodoCard(card); // 核心注入：读取存档时自适应 Todo 高度
            }

            // 核心修复：恢复全局卡片的自定义色彩
            if (cardState.bgColor && cardState.type !== 'note') card.style.backgroundColor = cardState.bgColor;
            if (cardState.borderColor && cardState.type !== 'note') card.style.borderTopColor = cardState.borderColor;

            if (cardState.type === 'column' && Array.isArray(cardState.children)) {
                cardState.children.forEach(childState => restoreCardFromState(childState, card));
            }
            return card;
        }

        function createCardFromState(cardState, isNested = false) {
            const x = Number.isFinite(cardState.x) ? cardState.x : 0; const y = Number.isFinite(cardState.y) ? cardState.y : 0;
            const width = Number.isFinite(cardState.width) ? cardState.width : null; const height = Number.isFinite(cardState.height) ? cardState.height : null;
            if (cardState.type === 'heading') {
                const card = createHeadingCard(x, y, cardState.html || "", width || 150, height || 'auto');
                if (cardState.fontSize) card.querySelector('.heading-text').style.fontSize = cardState.fontSize;
                return card;
            }
            if (cardState.type === 'note') return createNoteCard(x, y, cardState.html || "", width || 280, height || 180, isNested, cardState);
            if (cardState.type === 'link') return createLinkCard(x, y, cardState.url || "", isNested, cardState.articleClip || null);
            if (cardState.type === 'todo') return createTodoCard(x, y, cardState.itemsHtml || "", width || 260, height || 160, isNested);
            if (cardState.type === 'board') return createBoardCard(x, y, cardState.title || "New Board", "", cardState.id || null, cardState);
            if (cardState.type === 'column') return createColumnCard(x, y, cardState.title || "New Column", width || 400, height || 400, "");
            if (cardState.type === 'table') return createTableCard(x, y, cardState.html || "", width || 360, height || 180, isNested);
            if (cardState.type === 'comment') {
                const c = createCommentCard(x, y, cardState.listHtml || "", width || 320, height || 240, isNested);
                if (cardState.parentCardId) {
                    c.dataset.parentCardId = cardState.parentCardId;
                    // 初始化隐藏，等待 restoreWorkspaceState 二次挂载挂出标注
                    c.classList.add('comment-popover-mode');
                }
                return c;
            }
            if (cardState.type === 'image') return createImageCard(x, y, cardState.src || "", width || 300, height || 'auto', isNested);
            if (cardState.type === 'caption') return createCaptionCard(x, y, cardState.url || "", width || 380, height || 460, isNested);
            if (cardState.type === 'file') return createFileCard(x, y, cardState.filename, cardState.fileType, cardState.fileSize, cardState.fileData, cardState.noteHtml || "", width || 320, height || 'auto', isNested);
            return null;
        }

        function applyRootCardLayout(card, cardState) {
            if (Number.isFinite(cardState.x)) card.style.left = `${cardState.x}px`;
            if (Number.isFinite(cardState.y)) card.style.top = `${cardState.y}px`;
            if (Number.isFinite(cardState.width) && !card.classList.contains('board-card')) card.style.width = `${cardState.width}px`;
            if (card.classList.contains('column-card') || card.classList.contains('image-card')) { card.style.height = 'auto'; return; }
            if (Number.isFinite(cardState.height) && !card.classList.contains('board-card') && (!card.classList.contains('link-card') || cardState.articleClip)) { card.style.height = `${cardState.height}px`; }
        }

        function applyNestedCardLayout(card) {
            card.classList.add('nested-card'); card.style.left = 'auto'; card.style.top = 'auto'; card.style.width = '100%';
            card.style.height = 'auto'; // 修改为 auto，自适应预览高度
        }

        function serializeCard(card, isNested = false) {
            const type = card.dataset.type;
            const state = {
                id: card.id || null,
                type,
                boardId: card.dataset.boardId || ROOT_BOARD_ID,
                width: readCardMetric(card, 'width'),
                height: readCardMetric(card, 'height'),
                lastModified: card.dataset.lastModified || Date.now() // 🌟 核心新增：持久化审查时间
            };
            if (!isNested) { state.x = parseFloat(card.style.left) || 0; state.y = parseFloat(card.style.top) || 0; }
            if (type === 'heading') {
                const textEl = card.querySelector('.heading-text');
                state.html = textEl.innerHTML;
                state.fontSize = textEl.style.fontSize || '28px';
            } else if (type === 'note') {
                state.html = card.querySelector('.md-editor').innerHTML;
                const appearance = getNoteCardAppearance(card); state.accentColor = appearance.accentColor; state.backgroundColor = appearance.backgroundColor;
            } else if (type === 'link') {
                state.url = card.querySelector('.link-input').value;
                const articleClip = getLinkClipData(card);
                if (articleClip?.contentHtml) state.articleClip = articleClip;
            }
            else if (type === 'todo') {
                const listClone = cloneNodeWithFormState(card.querySelector('.todo-list-wrap')); const addBtn = listClone.querySelector('.todo-add-btn'); if (addBtn) addBtn.remove(); state.itemsHtml = listClone.innerHTML;
            } else if (type === 'board') {
                state.title = card.querySelector('.board-title').innerText;
                const iconBg = card.querySelector('.board-icon-bg');
                state.iconHtml = iconBg.innerHTML;
                state.iconBg = iconBg.style.backgroundImage;
            }
            else if (type === 'column') {
                state.title = card.querySelector('.column-title').innerText; const dropZone = card.querySelector('.column-drop-zone');
                state.children = Array.from(dropZone.children).filter(child => child.classList && child.classList.contains('card')).map(child => serializeCard(child, true));
            } else if (type === 'table') { state.html = card.querySelector('.table-wrap').innerHTML; }
            else if (type === 'comment') {
                state.listHtml = card.querySelector('.comment-list').innerHTML;
                // 持久化保存父卡片的绑定关系
                if (card.dataset.parentCardId) state.parentCardId = card.dataset.parentCardId;
            }
            else if (type === 'image') { state.src = card.querySelector('img').src; }
            else if (type === 'caption') {
                state.url = card.querySelector('.caption-header-input input').value;
                state.listHtml = card.querySelector('.caption-list').innerHTML;
            }
            else if (type === 'file') {
                state.filename = card.dataset.filename;
                state.fileType = card.dataset.fileType;
                state.fileSize = parseInt(card.dataset.fileSize);
                state.fileData = card.dataset.fileData; // 存放 Base64 数据
                const noteArea = card.querySelector('.pdf-note-area');
                state.noteHtml = noteArea ? noteArea.innerHTML : "";
            }

            // 核心修复：支持全局卡片的自定义边框和背景色记忆
            state.bgColor = card.style.backgroundColor || null;
            state.borderColor = card.style.borderTopColor || null;

            return state;
        }

        function cloneNodeWithFormState(node) {
            const clone = node.cloneNode(true); const sourceInputs = node.querySelectorAll('input'); const cloneInputs = clone.querySelectorAll('input');
            sourceInputs.forEach((input, index) => {
                const cloneInput = cloneInputs[index]; if (!cloneInput) return;
                if (input.type === 'checkbox') { cloneInput.checked = input.checked; if (input.checked) cloneInput.setAttribute('checked', 'checked'); else cloneInput.removeAttribute('checked'); }
                else { cloneInput.value = input.value; cloneInput.setAttribute('value', input.value); }
            });
            return clone;
        }

        function readCardMetric(card, property) {
            const inlineValue = parseFloat(card.style[property]); if (Number.isFinite(inlineValue) && inlineValue > 0) return inlineValue;
            const computedValue = parseFloat(window.getComputedStyle(card)[property]); if (Number.isFinite(computedValue) && computedValue > 0) return computedValue;
            const offsetValue = property === 'width' ? card.offsetWidth : card.offsetHeight; if (Number.isFinite(offsetValue) && offsetValue > 0) return offsetValue;
            return getDefaultCardMetric(card.dataset.type, property);
        }

        function getDefaultCardMetric(type, property) {
            const defaults = { note: { width: 280, height: 180 }, link: { width: 380, height: 70 }, todo: { width: 260, height: 160 }, board: { width: 160, height: 160 }, column: { width: 400, height: 400 }, table: { width: 360, height: 180 }, comment: { width: 320, height: 240 }, image: { width: 300, height: 200 } };
            return defaults[type]?.[property] || 0;
        }

        // 智能粘贴：URL → Link卡片，普通文字 → Note卡片
        function pasteExternalText(text, cx, cy) {
            // 检测纯URL（或带简短描述的URL）
            const urlMatch = text.match(/^(?:https?:\/\/[^\s]+|[^\s]+\.[a-z]{2,}\/[^\s]*)$/i);
            if (urlMatch) {
                const url = urlMatch[0];
                const card = createLinkCard(cx - 190, cy - 30, url);
                if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                return;
            }
            // 普通文字 → Note卡片
            const html = renderMarkdownToHtml(text);
            const cardW = text.length > 2000 ? 800 : (text.length > 500 ? 500 : 320);
            const card = createNoteCard(cx - cardW / 2, cy - 140, html, cardW, 280);
            if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
        }

        document.addEventListener('paste', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            const items = e.clipboardData.items;
            let hasImage = false;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    hasImage = true;
                    const blob = items[i].getAsFile();
                    compressImage(blob, (compressedDataUrl) => {
                        const rect = viewport.getBoundingClientRect();
                        const cx = (rect.width / 2 - panX) / scale, cy = (rect.height / 2 - panY) / scale;
                        createImageCard(cx - 150, cy - 150, compressedDataUrl);
                    });
                }
            }
            // 无图片但有文字 → 智能创建卡片
            if (!hasImage) {
                const text = e.clipboardData.getData('text/plain');
                if (text && text.trim()) {
                    const rect = viewport.getBoundingClientRect();
                    const cx = (rect.width / 2 - panX) / scale, cy = (rect.height / 2 - panY) / scale;
                    pasteExternalText(text.trim(), cx, cy);
                }
            }
        });

        function attachAndReturn(card, editorSelector) {
            canvas.appendChild(card); attachCardBaseEvents(card, editorSelector); attachPersistenceEvents(card);
            if (card.classList.contains('note-card')) {
                const editor = card.querySelector('.md-editor');
                editor.addEventListener('input', (e) => {
                    const sel = window.getSelection(); if (!sel.rangeCount) return;
                    const node = sel.getRangeAt(0).startContainer;
                    if (node.nodeType === 3) {
                        const text = node.textContent, offset = sel.anchorOffset;
                        if (offset <= 7) {
                            const hMatch = text.match(/^(#{1,6})\s/);
                            const bqMatch = text.match(/^>\s/);
                            const ulMatch = text.match(/^[-*]\s/);
                            const olMatch = text.match(/^(\d+)\.\s/);
                            const preMatch = text.match(/^```/);
                            const hrMatch = text.match(/^(---|___|\*\*\*)$/);

                            let matchedLen = 0, cmd = null, val = null;

                            // 补充修复：兼容部分浏览器对 formatBlock 参数的严格要求（需带尖括号，如 <H1>）
                            if (hMatch && offset === hMatch[0].length) { matchedLen = hMatch[0].length; cmd = 'formatBlock'; val = '<H' + hMatch[1].length + '>'; }
                            else if (bqMatch && offset === 2) { matchedLen = 2; cmd = 'formatBlock'; val = '<BLOCKQUOTE>'; }
                            else if (ulMatch && offset === 2) { matchedLen = 2; cmd = 'insertUnorderedList'; }
                            else if (olMatch && offset === olMatch[0].length) { matchedLen = olMatch[0].length; cmd = 'insertOrderedList'; }
                            else if (preMatch && offset >= 3) { matchedLen = 3; cmd = 'formatBlock'; val = '<PRE>'; }
                            else if (hrMatch && offset === 3) { matchedLen = 3; cmd = 'insertHorizontalRule'; }

                            if (cmd) {
                                const r = document.createRange();
                                r.setStart(node, 0);
                                r.setEnd(node, matchedLen);
                                sel.removeAllRanges();
                                sel.addRange(r);

                                if (cmd === 'insertHorizontalRule') {
                                    document.execCommand(cmd, false, val);
                                } else {
                                    // 核心终极修复：使用插入零宽字符（\u200B）替换选中的触发词（如 "# "）。
                                    // 既能销毁触发字符，又能确保当前节点不为空，同时自动将光标完美落脚在正确位置。
                                    // 彻底解决 formatBlock 在第一行或空行因选区丢失/无包裹元素而罢工的底层 Bug！
                                    document.execCommand('insertText', false, '\u200B');
                                    document.execCommand(cmd, false, val);
                                }
                                return;
                            }
                        }
                        const textBeforeCursor = text.substring(0, offset);
                        const boldMatch = textBeforeCursor.match(/\*\*(.+?)\*\*$/);
                        if (boldMatch) { const r = document.createRange(); r.setStart(node, offset - boldMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<strong>${boldMatch[1]}</strong>\u200B`); return; }
                        const italicMatch = textBeforeCursor.match(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)$/);
                        if (italicMatch) { const r = document.createRange(); r.setStart(node, offset - italicMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<em>${italicMatch[1]}</em>\u200B`); return; }
                        const strikeMatch = textBeforeCursor.match(/~~(.+?)~~$/);
                        if (strikeMatch) { const r = document.createRange(); r.setStart(node, offset - strikeMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<s>${strikeMatch[1]}</s>\u200B`); return; }
                        const hlMatch = textBeforeCursor.match(/==(.+?)==$/);
                        if (hlMatch) { const r = document.createRange(); r.setStart(node, offset - hlMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<mark>${hlMatch[1]}</mark>\u200B`); return; }
                        const codeMatch = textBeforeCursor.match(/`(.+?)`$/);
                        if (codeMatch && !textBeforeCursor.endsWith('```')) { const r = document.createRange(); r.setStart(node, offset - codeMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<code>${codeMatch[1]}</code>\u200B`); return; }

                        // 核心修复：实时解析与渲染 LaTeX 行内公式
                        const formulaMatch = textBeforeCursor.match(/\$(.+?)\$$/);
                        if (formulaMatch && !textBeforeCursor.endsWith('$$')) { const r = document.createRange(); r.setStart(node, offset - formulaMatch[0].length); r.setEnd(node, offset); sel.removeAllRanges(); sel.addRange(r); document.execCommand('insertHTML', false, `<span class="inline-formula" data-formula="${escapeAttribute(formulaMatch[1])}">${escapeHtml(formulaMatch[1])}</span>\u200B`); return; }
                    }
                    card.dataset.markdown = deriveMarkdownFromHtml(editor.innerHTML);
                    autoGrowNoteCard(card); updateMinimap(); scheduleSaveState();
                });
                editor.addEventListener('paste', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const text = (e.originalEvent || e).clipboardData.getData('text/plain');
                    if (text) {
                        if (window.marked && (text.includes('#') || text.includes('*') || text.includes('- ') || text.includes('```') || text.includes('>'))) {
                            const html = window.marked.parse(text);
                            document.execCommand('insertHTML', false, html);
                        } else {
                            document.execCommand('insertText', false, text);
                        }
                    }
                });
                editor.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        const sel = window.getSelection();
                        if (sel.rangeCount) {
                            const node = sel.anchorNode;
                            const block = node.nodeType === 3 ? node.parentNode : node;

                            // 核心修复：空列表项回车退出
                            const li = block.closest('li');
                            if (li && li.textContent.trim() === '') {
                                e.preventDefault();
                                document.execCommand('outdent', false, null);
                                return;
                            }

                            // 核心修复：空引用块回车退出
                            const bq = block.closest('blockquote');
                            if (bq && block.textContent.trim() === '') {
                                e.preventDefault();
                                document.execCommand('outdent', false, null);
                                document.execCommand('formatBlock', false, 'DIV');
                                return;
                            }

                            // 核心修复：解决格式状态粘连，空行回车自动清除高亮、代码等行内样式
                            if (block.textContent.trim() === '') {
                                const hasFormat = block.querySelector('mark, code, strong, em, u, s, span') || block.tagName !== 'DIV';
                                if (hasFormat) {
                                    e.preventDefault();
                                    document.execCommand('removeFormat', false, null);
                                    document.execCommand('formatBlock', false, 'DIV');
                                    // 彻底清洗空行内被浏览器强制残留的废弃标签
                                    if (block.innerHTML !== '<br>') {
                                        block.innerHTML = '';
                                        document.execCommand('insertHTML', false, '<br>');
                                    }
                                    return;
                                }
                            }
                        }
                    }
                    if (e.key === 'Tab') { e.preventDefault(); const isList = document.queryCommandState('insertUnorderedList') || document.queryCommandState('insertOrderedList'); if (isList) document.execCommand(e.shiftKey ? 'outdent' : 'indent', false, null); else document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;'); }
                    if (e.key === 'Escape') { editor.blur(); resetCardInteractiveState(card); }
                });

                // 核心修复：拦截默认复制操作，无损打包 HTML 和 Markdown 到剪贴板
                editor.addEventListener('copy', (e) => {
                    e.preventDefault();
                    const sel = window.getSelection();
                    if (!sel.rangeCount) return;
                    const container = document.createElement('div');
                    for (let i = 0; i < sel.rangeCount; i++) {
                        container.appendChild(sel.getRangeAt(i).cloneContents());
                    }
                    const htmlContent = container.innerHTML;
                    const mdContent = deriveMarkdownFromHtml(htmlContent);
                    // 同时写入富文本与纯文本，保证站内站外无损粘贴
                    e.clipboardData.setData('text/html', htmlContent);
                    e.clipboardData.setData('text/plain', mdContent);
                });

                autoGrowNoteCard(card);
            }
            return card;
        }

        const selectionBox = document.getElementById('selectionBox');

        function cancelAllSelection() {
            const activeEl = document.activeElement;
            if (activeEl && activeEl !== document.body && activeEl !== document.documentElement && typeof activeEl.blur === 'function') {
                activeEl.blur();
            }

            if (selectionBox) selectionBox.style.display = 'none';
            isSelecting = false;
            hasDraggedBox = false;

            if (isDrawingLine) {
                isDrawingLine = false;
                if (tempLineElement) tempLineElement.remove();
                tempLineElement = null;
                lineStartData = null;
            }

            setBoardInteractionActive(false);
            clearCardSelection();
        }

        const persistenceObserver = new MutationObserver((mutations) => {
            let shouldSave = false;
            mutations.forEach(mut => {
                if (mut.target === selectionBox) return;

                // 🌟 核心新增：审查时间追踪，只要卡片内部有任何实质变动，立刻更新最后修改时间戳
                const card = mut.target.nodeType === 1 ? mut.target.closest('.card') : mut.target.parentElement?.closest('.card');
                if (card && !card.classList.contains('is-tidying') && !card.classList.contains('search-highlight')) {
                    card.dataset.lastModified = Date.now();
                }

                if (mut.type === 'childList' || mut.type === 'characterData' || mut.type === 'attributes') {
                    shouldSave = true;
                }
            });
            if (shouldSave) scheduleSaveState(true); // 传入 true，标记这是单纯的内容流监听保存，不主动推入撤销栈
        });
        persistenceObserver.observe(canvas, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-board-id', 'src'] });

        viewport.addEventListener('mousedown', (e) => {
            if (e.target.closest('.card') || e.target.closest('.sidebar') || e.target.closest('.minimap-container') || e.target.closest('.top-right-actions') || e.target.closest('.note-toolbar')) return;

            // 🌟 拦截标题模式落笔
            if (isTitleMode) {
                if (e.button !== 0) return;
                isTitleMode = false;
                titleBtn.querySelector('.tool-icon').style.backgroundColor = 'var(--card-bg)';
                titleBtn.querySelector('.tool-icon').style.color = '';
                viewport.style.cursor = 'default';

                const cPos = getCanvasCoords(e);
                const newCard = createHeadingCard(cPos.x, cPos.y);
                requestAnimationFrame(() => {
                    clearCardSelection();
                    newCard.classList.add('selected');
                    newCard.classList.add('is-editing');
                    const textEl = newCard.querySelector('.heading-text');
                    textEl.setAttribute('contenteditable', 'true');
                    textEl.focus();
                });
                return;
            }

            // 🌟 拦截手绘模式落笔
            if (isDrawingMode) {
                if (e.button !== 0) return;
                isDrawing = true;
                const cPos = getCanvasCoords(e);
                currentStroke = [[cPos.x, cPos.y, e.pressure || 0.5]];

                currentPathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
                currentPathElement.setAttribute('fill', '#333');
                drawLayer.appendChild(currentPathElement);
                return;
            }

            if (e.target === viewport || e.target === canvas) {
                if (e.button === 1) return;
                isSelecting = true; hasDraggedBox = false;
                setBoardInteractionActive(true);
                const cPos = getCanvasCoords(e); startX = cPos.x; startY = cPos.y;
                selectionBox.style.left = startX + 'px'; selectionBox.style.top = startY + 'px'; selectionBox.style.width = '0px'; selectionBox.style.height = '0px'; selectionBox.style.display = 'block';
                clearCardSelection();
            }
        });

        viewport.addEventListener('dblclick', (e) => {
            if (e.target.closest('.card') || e.target.closest('.sidebar') || e.target.closest('.minimap-container') || e.target.closest('.top-right-actions') || e.target.closest('.transfer-drawer') || e.target.closest('.note-toolbar')) return;
            if (e.target !== viewport && e.target !== canvas) return;
            const cPos = getCanvasCoords(e);
            createQuickNoteAt(cPos.x - 160, cPos.y - 90);
        });

        const uploadFileBtn = document.getElementById('uploadFileBtn');
        const fileInput = document.getElementById('fileInput');
        if (uploadFileBtn && fileInput) {
            uploadFileBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => {
                const rect = viewport.getBoundingClientRect();
                const cx = (rect.width / 2 - panX) / scale;
                let cy = (rect.height / 2 - panY) / scale;

                Array.from(e.target.files).forEach((file, index) => {
                    const offsetX = index * 30; const offsetY = index * 30;
                    if (file.type.startsWith('image/')) {
                        compressImage(file, (dataUrl) => createImageCard(cx + offsetX, cy + offsetY, dataUrl));
                    } else if (file.name.toLowerCase().endsWith('.md') || file.type === 'text/markdown') {
                        // 🌟 MD 文件直开：智能计算宽度，防止卡片过度细长
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const text = ev.target.result;
                            const html = renderMarkdownToHtml(text);
                            const cardW = text.length > 2000 ? 800 : (text.length > 800 ? 600 : 400);
                            const card = createNoteCard(cx + offsetX, cy + offsetY, html, cardW, 300);
                            if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                        };
                        reader.readAsText(file);
                    } else {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const dataUrl = ev.target.result;
                            // 🌟 PDF 直开修复：同时兼容文件后缀名判断，防止部分系统缺失 file.type
                            const isPdfMode = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                            const w = isPdfMode ? 600 : 320;
                            const h = isPdfMode ? 800 : 'auto';
                            createFileCard(cx + offsetX, cy + offsetY, file.name, file.type, file.size, dataUrl, "", w, h);
                        };
                        reader.readAsDataURL(file);
                    }
                });
                e.target.value = ''; // 清空以允许重复上传同一文件
            });
        }

        window.addEventListener('mousemove', (e) => {
            // 🌟 新增：手绘引擎移动与动态笔锋生成
            if (isDrawingMode && isDrawing && currentPathElement) {
                const cPos = getCanvasCoords(e);
                currentStroke.push([cPos.x, cPos.y, e.pressure || 0.5]);

                // 调用 perfect-freehand 生成模拟压感的平滑墨迹
                const strokeOutline = perfectFreehand.getStroke(currentStroke, {
                    size: 8 / scale,
                    thinning: 0.5,
                    smoothing: 0.5,
                    streamline: 0.5,
                });
                currentPathElement.setAttribute('d', getSvgPathFromStroke(strokeOutline));
                return;
            }

            // --- 连线功能：动态绘制跟随鼠标的贝塞尔曲线 ---
            if (isDrawingLine && tempLineElement && lineStartData) {
                const startCard = document.getElementById(lineStartData.cardId);
                if (startCard) {
                    // 核心修复2：使用全新的卡片锚点算法替换掉已经废弃的 getConnectorPos，防止报错崩溃
                    const p1 = getCardAnchors(startCard)[lineStartData.anchor];
                    const p2 = getCanvasCoords(e);

                    // 智能推测目标锚点方向，让预览曲线更符合物理直觉
                    let tempAnchor = 'top';
                    if (p2.y > p1.y + 50) tempAnchor = 'bottom';
                    else if (p2.x < p1.x - 50) tempAnchor = 'right';
                    else if (p2.x > p1.x + 50) tempAnchor = 'left';

                    tempLineElement.setAttribute('d', getBezierPath(p1, p2, lineStartData.anchor, tempAnchor));
                }
                return; // 画线时屏蔽拖拽逻辑
            }

            // 物理缩放计算逻辑
            if (isResizingCard && currentCard) {
                const cPos = getCanvasCoords(e);
                const dx = cPos.x - dragStartCanvasPos.x;
                const dy = cPos.y - dragStartCanvasPos.y;
                let newW = resizeStartSize.w + dx;
                let newH = resizeStartSize.h + dy;
                if (currentCard.dataset.type === 'image') {
                    const ratio = resizeStartSize.h / resizeStartSize.w;
                    currentCard.style.width = Math.max(100, newW) + 'px';
                    currentCard.style.height = (Math.max(100, newW) * ratio) + 'px';
                } else if (currentCard.dataset.type === 'heading') {
                    const ratio = Math.max(0.2, newW / resizeStartSize.w);
                    const newFontSize = Math.max(12, resizeStartSize.fontSize * ratio);
                    currentCard.querySelector('.heading-text').style.fontSize = newFontSize + 'px';
                    // 🌟 终极约束：在拖拽拉伸的每一帧，都强行重置它的内联样式为自适应包裹！
                    currentCard.style.width = 'max-content';
                    currentCard.style.height = 'max-content';
                } else {
                    currentCard.style.width = Math.max(150, newW) + 'px';
                    if (currentCard.dataset.type !== 'column') {
                        currentCard.style.height = Math.max(80, newH) + 'px';
                        currentCard.dataset.manualHeight = 'true';
                    }
                }
                updateMinimap();
                renderLines(); // 缩放卡片时实时刷新连线
                return;
            }

            if (isDraggingCard && draggedCards.length > 0) {
                const cPos = getCanvasCoords(e); const dx = cPos.x - dragStartCanvasPos.x; const dy = cPos.y - dragStartCanvasPos.y;

                // 核心优化：防抖检测。鼠标移动超过 5px 才判定为真正的“拖拽动作”
                if (!hasStartedDraggingMove && Math.hypot(e.clientX - globalMouseDownX, e.clientY - globalMouseDownY) > 5) {
                    hasStartedDraggingMove = true;
                    // 正式拖拽开始，此时才将嵌套的卡片从 Column 里面物理剥离出来
                    draggedCards.forEach(item => {
                        const c = item.el;
                        if (item.isNested) {
                            const rect = item.initialRect;

                            // 核心新增：iOS风格“拔出”残影
                            const leavePlaceholder = document.createElement('div');
                            leavePlaceholder.className = 'column-drop-placeholder';
                            leavePlaceholder.style.height = (rect.height / scale) + 'px';
                            leavePlaceholder.style.marginBottom = '12px';
                            leavePlaceholder.style.opacity = '1';
                            c.parentNode.insertBefore(leavePlaceholder, c);
                            requestAnimationFrame(() => {
                                leavePlaceholder.style.height = '0px';
                                leavePlaceholder.style.marginBottom = '0px';
                                leavePlaceholder.style.opacity = '0';
                                setTimeout(() => leavePlaceholder.remove(), 400);
                            });

                            c.classList.remove('nested-card');
                            canvas.appendChild(c);
                            const worldPos = { x: (rect.left - viewport.getBoundingClientRect().left - panX)/scale, y: (rect.top - viewport.getBoundingClientRect().top - panY)/scale };
                            c.style.left = worldPos.x + 'px';
                            c.style.top = worldPos.y + 'px';
                            item.startX = worldPos.x;
                            item.startY = worldPos.y;

                            // 核心修复：拔出时恢复进入 Column 前的原始宽度和样式
                            if (c.dataset.origWidth) {
                                c.style.width = c.dataset.origWidth;
                            } else {
                                c.style.width = (rect.width / scale) + 'px';
                            }

                            if (c.dataset.origHeight) {
                                c.style.height = c.dataset.origHeight;
                            } else {
                                if (c.dataset.type === 'image' || c.dataset.type === 'link' || c.dataset.type === 'column') {
                                    c.style.height = 'auto';
                                } else {
                                    c.style.height = (rect.height / scale) + 'px';
                                }
                            }

                            if (c.dataset.type === 'note') {
                                autoGrowNoteCard(c);
                            } else if (c.dataset.type === 'todo') {
                                autoGrowTodoCard(c); // 核心注入：从收纳列拔出时恢复自适应能力
                            }
                        }
                        if (!c.classList.contains('note-card')) {
                            c.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(ed => ed.blur());
                        }
                    });
                }

                if (hasStartedDraggingMove) {
                    let isOverBoard = false;
                    draggedCards.forEach(item => { item.el.style.left = (item.startX + dx) + 'px'; item.el.style.top = (item.startY + dy) + 'px'; });
                    document.querySelectorAll('.board-card').forEach(b => {
                        if(draggedCards.some(d => d.el === b) || b.dataset.boardId !== getActiveBoard()) return;
                        const rect = b.getBoundingClientRect(); if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) isOverBoard = true;
                    });
                    draggedCards.forEach(item => { if (isOverBoard) item.el.classList.add('drag-over-board'); else item.el.classList.remove('drag-over-board'); });

                    // --- 核心新增：iOS 风格 Column “吸附”占位符动态展示逻辑 ---
                    let hoveredColumn = null;
                    if (!isOverBoard) {
                        document.querySelectorAll('.column-card').forEach(col => {
                            if (draggedCards.some(d => d.el === col) || col.dataset.boardId !== getActiveBoard()) return;
                            const rect = col.getBoundingClientRect(); if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) hoveredColumn = col;
                        });
                    }

                    let placeholder = document.getElementById('columnDropPlaceholder');
                    if (hoveredColumn) {
                        if (!placeholder) {
                            placeholder = document.createElement('div');
                            placeholder.id = 'columnDropPlaceholder';
                            placeholder.className = 'column-drop-placeholder';
                        }
                        const dropZone = hoveredColumn.querySelector('.column-drop-zone');
                        let beforeEl = null;
                        // 寻找插入点，排除正在拖拽的卡片
                        const children = [...dropZone.children].filter(c => c.classList.contains('card') && !draggedCards.some(d => d.el === c));
                        for (let child of children) {
                            const box = child.getBoundingClientRect();
                            if (e.clientY < box.top + box.height / 2) { beforeEl = child; break; }
                        }

                        // 如果位置改变，重置高度以重新触发撑开动画
                        if (placeholder.nextElementSibling !== beforeEl || placeholder.parentNode !== dropZone) {
                            placeholder.style.height = '0px';
                            placeholder.style.marginBottom = '0px';
                            placeholder.style.opacity = '0';
                            if (beforeEl) dropZone.insertBefore(placeholder, beforeEl);
                            else dropZone.appendChild(placeholder);
                            void placeholder.offsetWidth; // 强制重绘
                        }

                        // 动画展开到被拖拽卡片的目标高度
                        // 由于刚才我们在拔出时强制同步了真实物理尺寸，现在的卡片 offsetHeight 就是绝对完美的，不再需要任何补偿代码！
                        const targetHeight = draggedCards[0] ? (draggedCards[0].el.offsetHeight || 100) : 100;
                        placeholder.style.height = targetHeight + 'px';
                        placeholder.style.marginBottom = '12px';
                        placeholder.style.opacity = '1';
                    } else {
                        if (placeholder) placeholder.remove();
                    }

                    updateMinimap();
                    renderLines(); // 拖拽卡片时实时刷新连线
                }
            }
            if (isSelecting) {
                hasDraggedBox = true; const cPos = getCanvasCoords(e);
                selectionBox.style.width = Math.abs(cPos.x - startX) + 'px'; selectionBox.style.height = Math.abs(cPos.y - startY) + 'px';
                selectionBox.style.left = Math.min(cPos.x, startX) + 'px'; selectionBox.style.top = Math.min(cPos.y, startY) + 'px';
                const boxRect = selectionBox.getBoundingClientRect();
                getCards().forEach(card => {
                    if (card.classList.contains('nested-card') || card.dataset.boardId !== getActiveBoard()) return;
                    const cardRect = card.getBoundingClientRect();
                    const isIntersecting = !(boxRect.right < cardRect.left || boxRect.left > cardRect.right || boxRect.bottom < cardRect.top || boxRect.top > cardRect.bottom);
                    if (isIntersecting) card.classList.add('selected'); else card.classList.remove('selected');
                });
            }
        });

        window.addEventListener('mouseup', (e) => {
            // 🌟 新增：手绘引擎结束提笔逻辑
            if (isDrawingMode && isDrawing) {
                isDrawing = false;
                if (currentPathElement) scheduleSaveState();
                currentStroke = [];
                currentPathElement = null;
                return;
            }

            isResizingCard = false; // 释放缩放锁

            // --- 连线功能：磁吸并建立连接 ---
            // --- 连线功能：全区域智能磁吸并建立连接 ---
            if (isDrawingLine) {
                isDrawingLine = false;
                if (tempLineElement) tempLineElement.remove();

                // 核心体验提升：只要鼠标在任何卡片身上松开，立刻自动计算最短距离连线！
                const pointTarget = document.elementFromPoint(e.clientX, e.clientY);
                const targetCard = e.target.closest?.('.card') || pointTarget?.closest?.('.card');
                if (targetCard && lineStartData) {
                    if (!targetCard.id) targetCard.id = 'card-' + Date.now();

                    if (targetCard.id !== lineStartData.cardId) {
                        lines.push({
                            id: 'line-' + Date.now(),
                            from: lineStartData.cardId,
                            to: targetCard.id,
                            // 以下为新增独立属性
                            color: '#a0aab8', // 默认灰色
                            type: 'bezier',   // 默认曲线
                            style: 'solid',   // 默认实线
                            weight: 3,        // 默认粗细
                            arrow: 'forward', // 默认单向箭头
                            label: ''         // 默认无标签
                        });
                        renderLines();
                        scheduleSaveState();

                        // 🌟 核心新增：自动触发节点之间的联动逻辑
                        const fromNodeId = lineStartData.cardId;
                        const toNodeId = targetCard.id;
                        setTimeout(() => {
                            checkAndTriggerAutomation(fromNodeId, toNodeId);
                        }, 100);
                    }
                }
                lineStartData = null;
            }

            if (isSelecting) { isSelecting = false; selectionBox.style.display = 'none'; setTimeout(() => { hasDraggedBox = false; }, 0); }
            if (isDraggingCard && draggedCards.length > 0) {
                // 核心优化：只有真正发生位移的卡片才执行落点结算，纯点击事件直接忽略，保护 Click 事件。
                if (hasStartedDraggingMove) {
                    let droppedInBoard = null;
                    document.querySelectorAll('.board-card').forEach(b => {
                        if(draggedCards.some(d => d.el === b) || b.dataset.boardId !== getActiveBoard()) return;
                        const rect = b.getBoundingClientRect(); if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) droppedInBoard = b;
                    });
                    let droppedInColumn = null;

                    // 核心修复：直接读取悬停时生成的占位符（Placeholder），实现精准零误差掉落，无缝衔接动画
                    const placeholder = document.getElementById('columnDropPlaceholder');
                    if (placeholder && !droppedInBoard) {
                        droppedInColumn = placeholder.closest('.column-card');
                    } else if (!droppedInBoard) {
                        document.querySelectorAll('.column-card').forEach(col => {
                            if (draggedCards.some(d => d.el === col) || col.dataset.boardId !== getActiveBoard()) return;
                            const rect = col.getBoundingClientRect(); if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) droppedInColumn = col;
                        });
                    }

                    draggedCards.forEach(item => {
                        const c = item.el; c.classList.remove('drag-over-board');
                        if (droppedInBoard) {
                            c.dataset.boardId = droppedInBoard.id;
                            const existingCount = document.querySelectorAll(`.card:not(.nested-card)[data-board-id="${droppedInBoard.id}"]`).length;
                            const offset = 100 + (existingCount * 40); c.style.left = offset + 'px'; c.style.top = offset + 'px';
                            c.style.setProperty('display', 'none', 'important'); // 强制隐藏跨画板卡片
                        } else if (droppedInColumn) {
                            c.dataset.origWidth = c.style.width || c.offsetWidth + 'px';
                            c.dataset.origHeight = c.style.height || c.offsetHeight + 'px';

                            c.classList.add('nested-card'); c.style.left = 'auto'; c.style.top = 'auto'; c.style.width = '100%'; c.style.height = 'auto';
                            const dropZone = droppedInColumn.querySelector('.column-drop-zone');

                            // 优先替换占位符
                            if (placeholder && placeholder.parentNode === dropZone) {
                                dropZone.insertBefore(c, placeholder);
                            } else {
                                let beforeEl = null; const children = [...dropZone.querySelectorAll('.card.nested-card')];
                                for (let child of children) {
                                    if (draggedCards.some(d => d.el === child)) continue;
                                    const box = child.getBoundingClientRect(); if (e.clientY < box.top + box.height / 2) { beforeEl = child; break; }
                                }
                                if (beforeEl) dropZone.insertBefore(c, beforeEl); else dropZone.appendChild(c);
                            }
                        } else { c.dataset.boardId = getActiveBoard(); }
                    });

                    // 清理占位符
                    if (placeholder) placeholder.remove();

                    updateAllBoardCounts(); updateMinimap(); scheduleSaveState();
                }
                isDraggingCard = false; hasStartedDraggingMove = false; draggedCards = [];
            }
            setBoardInteractionActive(false);

        });
        window.addEventListener('blur', () => setBoardInteractionActive(false));

        const dragItems = ['Title', 'Note', 'Link', 'Todo', 'Board', 'Column', 'Table', 'Comment', 'Caption'];
        dragItems.forEach(item => { const btn = document.getElementById(item === 'Title' ? 'titleBtn' : 'drag' + item + 'Btn'); if(btn) btn.addEventListener('dragstart', (e) => e.dataTransfer.setData('source', item.toLowerCase()));});

        function isHtmlDropFile(file) {
            return !!file && (file.type === 'text/html' || /\.(html?|xhtml)$/i.test(file.name || ''));
        }

        function getFirstUrlFromHtml(html) {
            if (!html || !html.trim()) return '';
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const candidate = doc.querySelector('a[href], iframe[src], webview[src], video[src], source[src], img[src]');
                const raw = candidate?.getAttribute('href') || candidate?.getAttribute('src') || '';
                if (/^https?:\/\//i.test(raw)) return raw;
            } catch {}
            const match = String(html).match(/https?:\/\/[^\s"'<>]+/i);
            return match ? match[0] : '';
        }

        function sanitizeDroppedHtml(html) {
            const doc = new DOMParser().parseFromString(html || '', 'text/html');
            doc.querySelectorAll('script, style, link, meta, iframe, object, embed').forEach(el => el.remove());
            doc.body.querySelectorAll('*').forEach(el => {
                Array.from(el.attributes).forEach(attr => {
                    const name = attr.name.toLowerCase();
                    if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
                    if ((name === 'href' || name === 'src') && !/^(https?:|data:image\/)/i.test(attr.value)) el.removeAttribute(attr.name);
                });
            });
            return doc.body.innerHTML.trim();
        }

        viewport.addEventListener('dragover', (e) => { e.preventDefault(); viewport.classList.add('drag-over'); });
        viewport.addEventListener('dragleave', (e) => { if (!viewport.contains(e.relatedTarget)) viewport.classList.remove('drag-over'); });
        viewport.addEventListener('drop', (e) => {
            viewport.classList.remove('drag-over');
            e.preventDefault();
            const cPos = getCanvasCoords(e);
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                Array.from(e.dataTransfer.files).forEach((file, index) => {
                    const offsetX = index * 30; const offsetY = index * 30;
                    if (file.type.startsWith('image/')) {
                        compressImage(file, (dataUrl) => createImageCard(cPos.x + offsetX, cPos.y + offsetY, dataUrl));
                    } else if (isHtmlDropFile(file)) {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const dataUrl = ev.target.result;
                            const card = createFileCard(cPos.x + offsetX, cPos.y + offsetY, file.name, file.type || 'text/html', file.size, dataUrl, "", 760, 520);
                            if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                        };
                        reader.readAsDataURL(file);
                    } else if (file.name.toLowerCase().endsWith('.md') || file.type === 'text/markdown') {
                        // 🌟 拖拽 MD 自动生成自适应宽度的大号 Note 卡片
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const text = ev.target.result;
                            const html = renderMarkdownToHtml(text);
                            const cardW = text.length > 2000 ? 800 : (text.length > 800 ? 600 : 400);
                            const card = createNoteCard(cPos.x + offsetX, cPos.y + offsetY, html, cardW, 300);
                            if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                        };
                        reader.readAsText(file);
                    } else {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                            const dataUrl = ev.target.result;
                            // 🌟 拖拽 PDF 自动展开大屏阅读（修复 MIME 丢失问题）
                            const isPdfMode = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
                            const w = isPdfMode ? 600 : 320;
                            const h = isPdfMode ? 800 : 'auto';
                            createFileCard(cPos.x + offsetX, cPos.y + offsetY, file.name, file.type, file.size, dataUrl, "", w, h);
                        };
                        reader.readAsDataURL(file);
                    }
                });
                return;
            }
            const source = e.dataTransfer.getData('source');

            // 外部拖入纯文本 → 自动生成 Note 卡片
            if (!source) {
                const externalHtml = e.dataTransfer.getData('text/html');
                const htmlUrl = getFirstUrlFromHtml(externalHtml);
                if (htmlUrl) {
                    const card = createLinkCard(cPos.x, cPos.y, htmlUrl);
                    if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                    return;
                }
                if (externalHtml && externalHtml.trim()) {
                    const card = createNoteCard(cPos.x, cPos.y, sanitizeDroppedHtml(externalHtml), 520, 300);
                    if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                    return;
                }
                const externalText = e.dataTransfer.getData('text/plain');
                if (externalText && externalText.trim()) {
                    pasteExternalText(externalText.trim(), cPos.x, cPos.y);
                    return;
                }
            }

            if (!source) return;

            let droppedInColumn = null;
            document.querySelectorAll('.column-card').forEach(col => {
                if (col.dataset.boardId !== getActiveBoard()) return;
                const rect = col.getBoundingClientRect();
                if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) droppedInColumn = col;
            });
            const isNested = !!droppedInColumn;
            let newCard = null;

            if (source === 'title') {
                newCard = createHeadingCard(cPos.x, cPos.y);
                requestAnimationFrame(() => {
                    clearCardSelection(); newCard.classList.add('selected'); newCard.classList.add('is-editing');
                    const textEl = newCard.querySelector('.heading-text'); textEl.setAttribute('contenteditable', 'true'); textEl.focus();
                });
            }
            else if (source === 'note') newCard = createNoteCard(cPos.x, cPos.y, "", 280, 180, isNested);
            else if (source === 'link') newCard = createLinkCard(cPos.x, cPos.y, "", isNested);
            else if (source === 'todo') newCard = createTodoCard(cPos.x, cPos.y, "", 260, 160, isNested);
            else if (source === 'board') newCard = createBoardCard(cPos.x, cPos.y);
            else if (source === 'column') newCard = createColumnCard(cPos.x, cPos.y);
            else if (source === 'table') newCard = createTableCard(cPos.x, cPos.y, "", 360, 180, isNested);
            else if (source === 'comment') newCard = createCommentCard(cPos.x, cPos.y, "", 320, 240, isNested);
            else if (source === 'caption') newCard = createCaptionCard(cPos.x, cPos.y, "", 380, 460, isNested);
            else if (source === 'transfer-group' || source === 'trash-group' || source === 'template-group') {
                let bundle = null;
                let thumbElement = null;
                
                // 从模板中拖拽时解析独立数据源
                if (source === 'template-group') {
                    const index = e.dataTransfer.getData('templateIndex');
                    if (window.savedTemplates && window.savedTemplates[index]) {
                        bundle = window.savedTemplates[index].data;
                    }
                } else {
                    const thumbId = e.dataTransfer.getData('thumbId');
                    thumbElement = document.getElementById(thumbId);
                    if (thumbElement) bundle = thumbElement._bundleData;
                }
                if (!bundle) return;

                // 计算包裹边框以准确定位落点
                let minX = Infinity, minY = Infinity;
                bundle.cards.forEach(c => {
                    if (c.x < minX) minX = c.x;
                    if (c.y < minY) minY = c.y;
                });
                if (minX === Infinity) { minX = 0; minY = 0; }

                const offsetX = cPos.x - minX;
                const offsetY = cPos.y - minY;

                const idMap = {};
                clearCardSelection();

                                // 1. 恢复卡片并映射新ID
                bundle.cards.forEach(cState => {
                    const stateClone = JSON.parse(JSON.stringify(cState));
                    const oldId = stateClone.id;
                    const newId = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                    if (oldId) idMap[oldId] = newId;

                    stateClone.id = newId;
                    stateClone.boardId = getActiveBoard(); // 🌟 核心修复：覆盖原有 boardId，确保拖拽出在当前画板可见
                    stateClone.x += offsetX;
                    stateClone.y += offsetY;

                    const card = restoreCardFromState(stateClone, null);
                    if (card) {
                        card.classList.add('selected');
                        if (isNested && source !== 'board' && source !== 'column') {
                            newCard = card; // 让外层的列嵌套逻辑接管（如果正好拖进了收纳列中）
                        }
                    }
                });

                // 2. 恢复它们内部的关系（连线）
                bundle.lines.forEach(l => {
                    const newLine = JSON.parse(JSON.stringify(l));
                    newLine.id = 'line-' + Date.now() + Math.floor(Math.random() * 100000);
                    newLine.from = idMap[l.from] || l.from;
                    newLine.to = idMap[l.to] || l.to;
                    lines.push(newLine);
                });

                                // 核心差异：如果是从回收站拖出来的，说明是恢复操作，移除垃圾箱里的记录
                if (source === 'trash-group' && thumbElement) {
                    thumbElement.remove();
                    checkTrashEmptyState();
                }
                // (如果是模板或是中转站拖拽出来的，原数据均原封不动保留，实现无限拖拽)

                updateAllBoardCounts();
                updateMinimap();
                
                // 🌟 核心修复：拖拽模板到画布同样需要增加延迟，确保 DOM 识别后连线不会丢失
                setTimeout(() => {
                    renderLines();
                    scheduleSaveState();
                }, 50);
            }
            else if (source === 'trash-thumbnail') {
                const type = e.dataTransfer.getData('cardType');
                const savedW = parseInt(e.dataTransfer.getData('savedW')) || 280; const savedH = parseInt(e.dataTransfer.getData('savedH')) || 200;

                const thumbId = e.dataTransfer.getData('thumbId');
                const thumbElement = document.getElementById(thumbId);

                // 核心修复：从 DOM 上直接读取超大尺寸内容，不再依赖已被截断的 dataTransfer
                const savedHtml = thumbElement ? thumbElement._savedHtml : (e.dataTransfer.getData('savedHtml') || '');
                const deepHtml = thumbElement ? thumbElement._deepHtml : (e.dataTransfer.getData('deepHtml') || '');

                const originalId = e.dataTransfer.getData('originalId');
                const noteAccentColor = e.dataTransfer.getData('noteAccentColor'); const noteBackgroundColor = e.dataTransfer.getData('noteBackgroundColor');

                if(type === 'note') newCard = createNoteCard(cPos.x, cPos.y, savedHtml, savedW, savedH, isNested, { accentColor: noteAccentColor || noteDefaults.accentColor, backgroundColor: noteBackgroundColor || noteDefaults.backgroundColor });
                else if(type === 'link') newCard = createLinkCard(cPos.x, cPos.y, savedHtml, isNested);
                else if(type === 'todo') newCard = createTodoCard(cPos.x, cPos.y, savedHtml, savedW, savedH, isNested);
                else if(type === 'board') newCard = createBoardCard(cPos.x, cPos.y, savedHtml, deepHtml, originalId);
                else if(type === 'column') newCard = createColumnCard(cPos.x, cPos.y, savedHtml, savedW, savedH, deepHtml);
                else if(type === 'table') newCard = createTableCard(cPos.x, cPos.y, savedHtml, savedW, savedH, isNested);
                else if(type === 'comment') newCard = createCommentCard(cPos.x, cPos.y, savedHtml, savedW, savedH, isNested);
                else if(type === 'image') newCard = createImageCard(cPos.x, cPos.y, savedHtml, savedW, savedH, isNested);

                if(thumbElement) thumbElement.remove();
                checkTrashEmptyState();
            }

            if (newCard && isNested && source !== 'board' && source !== 'column') {
                newCard.dataset.boardId = droppedInColumn.dataset.boardId;
                const dropZone = droppedInColumn.querySelector('.column-drop-zone');
                let beforeEl = null; const children = [...dropZone.querySelectorAll('.card.nested-card')];
                for (let child of children) {
                    const box = child.getBoundingClientRect(); if (e.clientY < box.top + box.height / 2) { beforeEl = child; break; }
                }
                if (beforeEl) dropZone.insertBefore(newCard, beforeEl); else dropZone.appendChild(newCard);
            }
            updateAllBoardCounts(); updateMinimap();
        });

        function checkTrashEmptyState() {
            const isEmpty = document.getElementById('myTrashGrid').children.length === 0;
            document.getElementById('myTrashEmpty').style.display = isEmpty ? 'flex' : 'none';
            const emptyBtn = document.getElementById('emptyTrashBtn');
            if (emptyBtn) emptyBtn.disabled = isEmpty;
        }

        // 核心新增：监听清空垃圾箱按钮的点击事件
        // 核心新增：监听清空垃圾箱按钮，改为触发内嵌高颜值面板
        const emptyTrashBtn = document.getElementById('emptyTrashBtn');
        const trashConfirmOverlay = document.getElementById('trashConfirmOverlay');
        const cancelEmptyBtn = document.getElementById('cancelEmptyBtn');
        const confirmEmptyBtn = document.getElementById('confirmEmptyBtn');

        if (emptyTrashBtn && trashConfirmOverlay) {
            emptyTrashBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const trashGrid = document.getElementById('myTrashGrid');
                if (trashGrid.children.length === 0) return;
                // 唤醒内部遮罩层，而不是浏览器弹窗
                trashConfirmOverlay.classList.add('show');
            });
        }

        if (cancelEmptyBtn) {
            cancelEmptyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                trashConfirmOverlay.classList.remove('show');
            });
        }

        if (confirmEmptyBtn) {
            confirmEmptyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const trashGrid = document.getElementById('myTrashGrid');
                trashGrid.innerHTML = '';
                checkTrashEmptyState();
                trashConfirmOverlay.classList.remove('show');
            });
        }

        function deleteSelectedCards() {
            const selectedCards = document.querySelectorAll('.card.selected');
            let targets = Array.from(selectedCards);
            if (targets.length === 0) return;
            const trashGrid = document.getElementById('myTrashGrid');

            // 【核心重构】：垃圾桶也采用“组合包”逻辑，支持多选并保留连线
            const groupData = { cards: [], lines: [] };
            const targetIds = new Set(targets.map(c => c.id));
            let previewText = "";
            let thumbType = "group";

            targets.forEach(card => {
                groupData.cards.push(serializeCard(card, false));
            });

            const internalLines = lines.filter(l => targetIds.has(l.from) && targetIds.has(l.to));
            groupData.lines = internalLines.map(l => ({...l}));

            if (targets.length === 1) {
                const card = targets[0];
                thumbType = card.dataset.type;
                if (thumbType === 'note') previewText = card.querySelector('.md-editor').innerText.trim().substring(0, 20) || '便签';
                else if (thumbType === 'link') previewText = "🔗 " + getLinkCardLabel(card);
                else if (thumbType === 'todo') previewText = "☑️ 任务清单";
                else if (thumbType === 'board') previewText = "📁 " + card.querySelector('.board-title').innerText;
                else if (thumbType === 'column') previewText = "🗂️ " + card.querySelector('.column-title').innerText;
                else if (thumbType === 'table') previewText = "📊 表格数据";
                else if (thumbType === 'comment') previewText = "💬 讨论记录";
                else if (thumbType === 'image') previewText = "🖼️ 图片";
                else if (thumbType === 'file') previewText = "📎 " + card.dataset.filename;
            } else {
                previewText = `🗑️ 已删除 (${targets.length} 卡片, ${internalLines.length} 连线)`;
                thumbType = "group";
            }

                        // 执行真实删除操作
            targets.forEach(card => {
                const originalId = card.id;
                if (originalId) lines = lines.filter(l => l.from !== originalId && l.to !== originalId);

                // 如果是 board 还要清理它包含的子卡片
                if (card.dataset.type === 'board') {
                    document.querySelectorAll(`.card:not(.nested-card)[data-board-id="${originalId}"]`).forEach(c => c.remove());
                }

                // 🌟 核心修复1：如果删除的是弹窗评论卡片，清空父级卡片上的数字徽章，或解除行内文字的评论高亮
                if (card.dataset.type === 'comment' && card.dataset.parentCardId) {
                    const anchorEl = document.getElementById(card.dataset.parentCardId);
                    if (anchorEl) {
                        if (anchorEl.classList.contains('card')) {
                            // 1. 卡片级评论：移除右上角数字徽章
                            const badge = anchorEl.querySelector('.card-comment-badge');
                            if (badge) badge.remove();
                        } else if (anchorEl.classList.contains('inline-comment')) {
                            // 2. 行内文字评论：剥离带颜色的 span 外壳，还原纯文本
                            const parentEditor = anchorEl.closest('.md-editor');
                            anchorEl.outerHTML = anchorEl.innerHTML; 
                            
                            // 触发所属笔记卡片的底层 Markdown 数据更新
                            if (parentEditor) {
                                const noteCard = parentEditor.closest('.note-card');
                                if (noteCard && typeof deriveMarkdownFromHtml === 'function') {
                                    noteCard.dataset.markdown = deriveMarkdownFromHtml(parentEditor.innerHTML);
                                }
                            }
                        }
                    }
                }
                // 🌟 核心修复2：如果被删除的是父级卡片，连带物理销毁它专属的弹窗评论卡片
                const linkedCommentCard = document.querySelector(`.comment-card[data-parent-card-id="${originalId}"]`);
                if (linkedCommentCard) {
                    linkedCommentCard.remove();
                }

                card.remove();
            });

            updateMinimap(); updateAllBoardCounts(); renderLines();

            const thumb = document.createElement('div');
            thumb.className = 'trash-thumbnail';
            thumb.draggable = true;
            const thumbId = 'trash-' + Date.now() + Math.floor(Math.random() * 1000);
            thumb.id = thumbId;
            thumb.innerHTML = `<div class="thumb-header" style="color:#ef4444; border-bottom-color:rgba(239,68,68,0.2);">${thumbType === 'group' ? 'Group' : thumbType}</div><div class="thumb-body" style="font-size:11px;">${escapeHtml(previewText)}</div>`;

            thumb._bundleData = groupData;

            thumb.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('source', 'trash-group');
                e.dataTransfer.setData('thumbId', thumbId);
            });
            trashGrid.appendChild(thumb);

            clearCardSelection();
            checkTrashEmptyState();
            scheduleSaveState();
        }

        document.addEventListener('keydown', (e) => {
            const isEditingText = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.getAttribute('contenteditable') === 'true' || e.target.isContentEditable;
            const isCtrl = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();

            // 处于文本编辑时，除了 Esc 强制失焦外，其他快捷键一律放行给原生浏览器处理
            if (isEditingText) {
                if (key === 'escape') {
                    e.preventDefault();
                    cancelAllSelection();
                }
                return;
            }

            if (isCtrl && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) performRedo(); else performUndo();
                return;
            }
            if (isCtrl && key === 'y') {
                e.preventDefault();
                performRedo();
                return;
            }
            if (isCtrl && key === 'c') {
                e.preventDefault();
                const targets = document.querySelectorAll('.card.selected');
                if (targets.length > 0) {
                    cardClipboard = Array.from(targets).map(c => serializeCard(c, false));
                    // 单张图片卡片：把图片数据写入系统剪贴板，可粘贴到外部应用
                    if (targets.length === 1 && targets[0].dataset.type === 'image') {
                        const img = targets[0].querySelector('img');
                        if (img && img.src) {
                            fetch(img.src).then(r => r.blob()).then(blob => {
                                try { navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); } catch(_) {}
                            }).catch(() => {});
                        }
                    }
                    if (typeof showToast === 'function') showToast(`已复制 ${targets.length} 张卡片`, 'success');
                }
                return;
            }
            if (isCtrl && key === 'x') {
                e.preventDefault();
                const targets = document.querySelectorAll('.card.selected');
                if (targets.length > 0) {
                    cardClipboard = Array.from(targets).map(c => serializeCard(c, false));
                    deleteSelectedCards();
                    if (typeof showToast === 'function') showToast(`已剪切 ${targets.length} 张卡片`, 'success');
                }
                return;
            }
            if (isCtrl && key === 'v') {
                e.preventDefault();
                if (cardClipboard && cardClipboard.length > 0) {
                    clearCardSelection();
                    const rect = viewport.getBoundingClientRect();
                    const pasteX = (rect.width / 2 - panX) / scale;
                    const pasteY = (rect.height / 2 - panY) / scale;

                    let minX = Infinity, minY = Infinity;
                    cardClipboard.forEach(c => {
                        if (c.x < minX) minX = c.x;
                        if (c.y < minY) minY = c.y;
                    });

                    cardClipboard.forEach(state => {
                        const newState = JSON.parse(JSON.stringify(state));
                        newState.id = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                        newState.boardId = getActiveBoard();
                        newState.x = pasteX + (state.x - minX);
                        newState.y = pasteY + (state.y - minY);
                        const newCard = restoreCardFromState(newState, null);
                        if (newCard) newCard.classList.add('selected');
                    });
                    updateMinimap(); scheduleSaveState();
                    if (typeof showToast === 'function') showToast(`已粘贴 ${cardClipboard.length} 张卡片`, 'success');
                } else {
                    // 从系统剪贴板读取外部内容：图片优先 → URL → 文字
                    const rect = viewport.getBoundingClientRect();
                    const cx = (rect.width / 2 - panX) / scale;
                    const cy = (rect.height / 2 - panY) / scale;
                    if (navigator.clipboard && navigator.clipboard.read) {
                        navigator.clipboard.read().then(items => {
                            for (const item of items) {
                                for (const type of item.types) {
                                    if (type.startsWith('image/')) {
                                        item.getType(type).then(blob => {
                                            compressImage(blob, (dataUrl) => {
                                                const card = createImageCard(cx - 150, cy - 150, dataUrl);
                                                if (card) { clearCardSelection(); card.classList.add('selected'); updateMinimap(); scheduleSaveState(); }
                                            });
                                        });
                                        return;
                                    }
                                }
                            }
                            // 无图片时读取文字
                            navigator.clipboard.readText().then(text => {
                                if (text && text.trim()) pasteExternalText(text.trim(), cx, cy);
                            }).catch(() => {});
                        }).catch(() => {
                            // 回退：无法 read() 时尝试 readText
                            navigator.clipboard.readText().then(text => {
                                if (text && text.trim()) pasteExternalText(text.trim(), cx, cy);
                            }).catch(() => {
                                if (typeof showToast === 'function') showToast('剪贴板为空', 'warning');
                            });
                        });
                    } else {
                        // 旧浏览器回退
                        navigator.clipboard.readText().then(text => {
                            if (text && text.trim()) pasteExternalText(text.trim(), cx, cy);
                            else if (typeof showToast === 'function') showToast('剪贴板为空', 'warning');
                        }).catch(() => {
                            if (typeof showToast === 'function') showToast('剪贴板为空', 'warning');
                        });
                    }
                }
                return;
            }
            if (isCtrl && key === 'd') {
                e.preventDefault();
                const targets = document.querySelectorAll('.card.selected');
                if (targets.length > 0) {
                    const clonedCards = [];
                    targets.forEach(c => {
                        const state = serializeCard(c, false);
                        state.id = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                        state.boardId = getActiveBoard();
                        state.x += 40;
                        state.y += 40;
                        clonedCards.push(state);
                    });
                    clearCardSelection();
                    clonedCards.forEach(state => {
                        const newCard = restoreCardFromState(state, null);
                        if (newCard) newCard.classList.add('selected');
                    });
                    updateMinimap(); scheduleSaveState();
                    if (typeof showToast === 'function') showToast(`已克隆 ${targets.length} 张卡片`, 'success');
                }
                return;
            }
            if (isCtrl && key === 'a') {
                e.preventDefault();
                clearCardSelection();
                const active = getActiveBoard();
                document.querySelectorAll(`.card:not(.nested-card)[data-board-id="${active}"]`).forEach(c => c.classList.add('selected'));
                if (typeof showToast === 'function') showToast(`已选中 ${document.querySelectorAll('.card.selected').length} 张卡片`, 'info', 1500);
                return;
            }
            if (key === 'escape') {
                e.preventDefault();
                cancelAllSelection();
                return;
            }
            if (key === 'backspace' || key === 'delete') {
                e.preventDefault();
                if (selectedLineId) {
                    lines = lines.filter(l => l.id !== selectedLineId);
                    selectedLineId = null;
                    renderLines();
                    scheduleSaveState();
                } else {
                    deleteSelectedCards();
                }
                return;
            }
        });

        // --- 核心新增：添加到中转站的逻辑 ---
        function checkTransferEmptyState() {
            const grid = document.getElementById('transferGrid');
            const empty = document.getElementById('transferEmpty');
            if (grid && empty) empty.style.display = grid.children.length === 0 ? 'flex' : 'none';
        }

        function sendSelectedToTransfer() {
            const selectedCards = document.querySelectorAll('.card.selected');
            let targets = Array.from(selectedCards);
            if (targets.length === 0 && rightClickedCard) targets = [rightClickedCard];
            if (targets.length === 0) return;

            const transferGrid = document.getElementById('transferGrid');
            if (!transferGrid) return;

            // 【新版中转站逻辑】：将选中的多张卡片及内部连线打包成一个“剪贴板组”，并保留原卡片不删除
            const groupData = { cards: [], lines: [] };
            const targetIds = new Set(targets.map(c => c.id));
            let previewText = "";
            let thumbType = "group";

            // 序列化所有卡片
            targets.forEach(card => {
                groupData.cards.push(serializeCard(card, false));
            });

            // 提取仅在这些选中卡片之间的内部连线
            const internalLines = lines.filter(l => targetIds.has(l.from) && targetIds.has(l.to));
            groupData.lines = internalLines.map(l => ({...l}));

            if (targets.length === 1) {
                const card = targets[0];
                thumbType = card.dataset.type;
                if (thumbType === 'note') previewText = card.querySelector('.md-editor').innerText.trim().substring(0, 20) || '便签';
                else if (thumbType === 'link') previewText = "🔗 " + getLinkCardLabel(card);
                else if (thumbType === 'todo') previewText = "☑️ 任务清单";
                else if (thumbType === 'board') previewText = "📁 " + card.querySelector('.board-title').innerText;
                else if (thumbType === 'column') previewText = "🗂️ " + card.querySelector('.column-title').innerText;
                else if (thumbType === 'table') previewText = "📊 表格数据";
                else if (thumbType === 'comment') previewText = "💬 讨论记录";
                else if (thumbType === 'image') previewText = "🖼️ 图片";
                else if (thumbType === 'file') previewText = "📎 " + card.dataset.filename;
            } else {
                previewText = `📦 组合包 (${targets.length} 卡片, ${internalLines.length} 连线)`;
                thumbType = "group";
            }

            const thumb = document.createElement('div');
            thumb.className = 'trash-thumbnail'; // 复用缩略图样式
            thumb.draggable = true;
            const thumbId = 'transfer-' + Date.now() + Math.floor(Math.random() * 1000);
            thumb.id = thumbId;
            thumb.innerHTML = `<div class="thumb-header" style="color:var(--primary-blue); border-bottom-color:rgba(91,130,251,0.2);">${thumbType === 'group' ? 'Group' : thumbType}</div><div class="thumb-body" style="font-size:11px;">${escapeHtml(previewText)}</div>`;

            // 移除按钮 (从中转站删除)
            const delBtn = document.createElement('div');
            delBtn.innerHTML = '&times;';
            delBtn.style.cssText = 'position:absolute; top:2px; right:6px; font-size:16px; cursor:pointer; color:#a0aab8;';
            delBtn.onclick = (e) => { e.stopPropagation(); thumb.remove(); checkTransferEmptyState(); scheduleSaveState(); };
            thumb.style.position = 'relative';
            thumb.appendChild(delBtn);

            // 挂载超级数据包
            thumb._bundleData = groupData;

            thumb.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('source', 'transfer-group');
                e.dataTransfer.setData('thumbId', thumbId);
            });
            transferGrid.appendChild(thumb);

            // 核心逻辑修改：将源卡片彻底“剪切”（删除），同时清理相连的所有全局连线
            targets.forEach(card => {
                const originalId = card.id;
                if (originalId) lines = lines.filter(l => l.from !== originalId && l.to !== originalId);
                card.remove();
            });

            // 更新视图和连线
            clearCardSelection();
            updateAllBoardCounts();
            updateMinimap();
            renderLines();
            checkTransferEmptyState();
            scheduleSaveState();

            if (typeof showToast === 'function') showToast('已剪切至中转站，可无限次拖出复用', 'success');

            // 如果抽屉没开，给按钮一个动效提示
            const transferBtn = document.getElementById('transferBtn');
            transferBtn.style.transform = 'scale(1.1)';
            setTimeout(() => { transferBtn.style.transform = ''; }, 200);
        }
        // ------------------------------------------

        const transferBtn = document.getElementById('transferBtn');
        const transferDrawer = document.getElementById('transferDrawer');
        const closeTransferBtn = document.getElementById('closeTransferBtn');

        const templateBtn = document.getElementById('templateBtn');
        const templateDrawer = document.getElementById('templateDrawer');
        const closeTemplateBtn = document.getElementById('closeTemplateBtn');

        // ====== 模板库核心引擎 ======
        window.savedTemplates = JSON.parse(localStorage.getItem('gemeni-templates') || '[]');

        function renderTemplates() {
            const grid = document.getElementById('templateGrid');
            const empty = document.getElementById('templateEmpty');
            if (!grid || !empty) return;
            grid.innerHTML = '';
            if (window.savedTemplates.length === 0) {
                empty.style.display = 'flex';
            } else {
                empty.style.display = 'none';
                window.savedTemplates.forEach((tpl, index) => {
                    const thumb = document.createElement('div');
                    thumb.className = 'trash-thumbnail';
                    thumb.draggable = true;
                    thumb.style.position = 'relative';
                    thumb.innerHTML = `<div class="thumb-header" style="color:#10b981; border-bottom-color:rgba(16,185,129,0.2); font-size:12px; padding-right:40px;">
                        <span class="tpl-name-text"><i class="fa-solid fa-cube"></i> ${escapeHtml(tpl.name)}</span>
                        <input class="tpl-name-input" value="${escapeHtml(tpl.name)}" style="display:none; width:100%; padding:2px 4px; font-size:11px; border:1px solid var(--primary-blue); border-radius:4px; outline:none;">
                    </div><div class="thumb-body" style="font-size:11px; color:#666; margin-top:6px;">📦 ${tpl.data.cards.length} 卡片, ${tpl.data.lines.length} 连线</div>`;

                    // 重命名
                    const nameText = thumb.querySelector('.tpl-name-text');
                    const nameInput = thumb.querySelector('.tpl-name-input');
                    const renameBtn = document.createElement('div');
                    renameBtn.innerHTML = '<i class="fa-solid fa-pen" style="font-size:10px;"></i>';
                    renameBtn.style.cssText = 'position:absolute; top:4px; right:22px; cursor:pointer; color:#a0aab8; padding:2px 4px;';
                    renameBtn.title = '重命名';
                    renameBtn.onclick = (e) => {
                        e.stopPropagation();
                        nameText.style.display = 'none';
                        nameInput.style.display = 'block';
                        nameInput.focus();
                        nameInput.select();
                    };
                    nameInput.addEventListener('blur', () => {
                        const newName = nameInput.value.trim() || tpl.name;
                        window.savedTemplates[index].name = newName;
                        localStorage.setItem('gemeni-templates', JSON.stringify(window.savedTemplates));
                        nameInput.style.display = 'none';
                        nameText.innerHTML = `<i class="fa-solid fa-cube"></i> ${escapeHtml(newName)}`;
                        nameText.style.display = '';
                    });
                    nameInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') nameInput.blur();
                        if (e.key === 'Escape') { nameInput.value = tpl.name; nameInput.blur(); }
                    });
                    thumb.appendChild(renameBtn);

                    // 删除
                    const delBtn = document.createElement('div');
                    delBtn.innerHTML = '&times;';
                    delBtn.style.cssText = 'position:absolute; top:2px; right:4px; font-size:16px; cursor:pointer; color:#a0aab8; transition:color 0.2s;';
                    delBtn.onmouseenter = () => delBtn.style.color = '#ef4444';
                    delBtn.onmouseleave = () => delBtn.style.color = '#a0aab8';
                    delBtn.onclick = (e) => {
                        e.stopPropagation();
                        window.savedTemplates.splice(index, 1);
                        localStorage.setItem('gemeni-templates', JSON.stringify(window.savedTemplates));
                        renderTemplates();
                    };
                    thumb.appendChild(delBtn);
                    
                    // 1. 挂载拖拽引擎
                    thumb.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('source', 'template-group');
                        e.dataTransfer.setData('templateIndex', index);
                    });
                    
                    // 2. 挂载点击直接实例化引擎 (在视野正中央生成)
                    thumb.addEventListener('click', () => {
                        const rect = viewport.getBoundingClientRect();
                        const cx = (rect.width / 2 - panX) / scale;
                        const cy = (rect.height / 2 - panY) / scale;
                        instantiateTemplate(tpl.data, cx, cy);
                    });
                    
                    grid.appendChild(thumb);
                });
            }
        }

        function instantiateTemplate(bundle, cx, cy) {
            let minX = Infinity, minY = Infinity;
            bundle.cards.forEach(c => { if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y; });
            if (minX === Infinity) { minX = 0; minY = 0; }
            const offsetX = cx - minX;
            const offsetY = cy - minY;
            const idMap = {};
            clearCardSelection();
            
                                    // 批量恢复卡片并映射新的物理 ID
            bundle.cards.forEach(cState => {
                const stateClone = JSON.parse(JSON.stringify(cState));
                const oldId = stateClone.id; // 此时 cState 已经带有 ID 了
                const newId = 'card-' + Date.now() + Math.floor(Math.random() * 100001);
                
                // 🌟 建立映射关系：让连线知道“原来的 A 卡片”现在变成了“新生成的 B 卡片”
                if (oldId) idMap[oldId] = newId; 
                
                stateClone.id = newId;
                stateClone.boardId = getActiveBoard(); // 🌟 核心修复：强制将模板卡片的归属画板修改为当前所在的画板
                stateClone.x += offsetX;
                stateClone.y += offsetY;
                const card = restoreCardFromState(stateClone, null);
                if (card) card.classList.add('selected');
            });
            
            // 批量恢复模板内原本绑定的连线关系
            if (bundle.lines && bundle.lines.length > 0) {
                bundle.lines.forEach(l => {
                    const newLine = JSON.parse(JSON.stringify(l));
                    newLine.id = 'line-' + Date.now() + Math.floor(Math.random() * 100002);
                    // 🌟 使用映射后的新 ID 替换旧 ID
                    newLine.from = idMap[l.from] || l.from;
                    newLine.to = idMap[l.to] || l.to;
                    lines.push(newLine);
                });
            }
            
            updateAllBoardCounts(); 
            updateMinimap(); 
            
            // 🌟 关键修改：增加 50ms 延迟渲染，确保 DOM 已识别所有新 ID 的卡片
            setTimeout(() => {
                renderLines();
                scheduleSaveState();
            }, 50);

            if (typeof showToast === 'function') showToast('✅ 模板套用成功！', 'success');
        }

        // ====== 抽屉防重叠调度逻辑 ======
        function toggleTransferDrawer() {
            if (templateDrawer && templateDrawer.classList.contains('open')) toggleTemplateDrawer(); // 互斥
            transferDrawer.classList.toggle('open');
            const icon = transferBtn.querySelector('i');
            if(transferDrawer.classList.contains('open')) { icon.className = 'fa-solid fa-xmark'; transferBtn.style.color = 'var(--primary-blue)'; }
            else { icon.className = 'fa-solid fa-inbox'; transferBtn.style.color = 'var(--text-primary)'; }
        }

        function toggleTemplateDrawer() {
            if (transferDrawer && transferDrawer.classList.contains('open')) toggleTransferDrawer(); // 互斥
            templateDrawer.classList.toggle('open');
            const icon = templateBtn.querySelector('i');
            if(templateDrawer.classList.contains('open')) { icon.className = 'fa-solid fa-xmark'; templateBtn.style.color = 'var(--primary-blue)'; renderTemplates(); }
            else { icon.className = 'fa-solid fa-shapes'; templateBtn.style.color = 'var(--text-primary)'; }
        }

        transferBtn.addEventListener('mousedown', e => e.stopPropagation());
        transferBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTransferDrawer(); });
        if (closeTransferBtn) { closeTransferBtn.addEventListener('click', (e) => { e.stopPropagation(); if (transferDrawer.classList.contains('open')) toggleTransferDrawer(); }); }

        if (templateBtn) {
            templateBtn.addEventListener('mousedown', e => e.stopPropagation());
            templateBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTemplateDrawer(); });
        }
        if (closeTemplateBtn) { 
            closeTemplateBtn.addEventListener('click', (e) => { e.stopPropagation(); if (templateDrawer.classList.contains('open')) toggleTemplateDrawer(); }); 
        }

        // 将选区序列化为模板包的按钮逻辑
        const templateNameInput = document.getElementById('templateNameInput');
        const saveTemplateBtn = document.getElementById('saveTemplateBtn');
        if (saveTemplateBtn && templateNameInput) {
            saveTemplateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const selectedCards = document.querySelectorAll('.card.selected');
                let targets = Array.from(selectedCards);
                if (targets.length === 0) {
                    if (typeof showToast === 'function') showToast('⚠️ 请先在画布上选中要存为模板的卡片', 'warning');
                    return;
                }
                const tplName = templateNameInput.value.trim() || '未命名模板';
                
                                const groupData = { cards: [], lines: [] };
                const targetIds = new Set(targets.map(c => c.id));
                
                // 🌟 核心修复：改回 false！
                // 第二个参数是 isNested，如果传 true 会导致不保存物理坐标(x,y)！
                // serializeCard 本身就会一直保存 id，所以传 false 既能保存 id 也能保存坐标
                targets.forEach(card => groupData.cards.push(serializeCard(card, false))); 
                
                const internalLines = lines.filter(l => targetIds.has(l.from) && targetIds.has(l.to));
                groupData.lines = internalLines.map(l => ({...l}));
                
                window.savedTemplates.push({ name: tplName, data: groupData });
                localStorage.setItem('gemeni-templates', JSON.stringify(window.savedTemplates));
                templateNameInput.value = '';
                renderTemplates();
                if (typeof showToast === 'function') showToast('✅ 模板保存成功！', 'success');
            });
        }

        function setupPopover(btnId, popoverId) {
            const btn = document.getElementById(btnId); const popover = document.getElementById(popoverId);
            btn.addEventListener('click', (e) => {
                if (btnId === 'trashBtn' && document.querySelectorAll('.card.selected').length > 0) { deleteSelectedCards(); return; }
                document.querySelectorAll('.popover-menu, .trash-popover').forEach(p => { if (p !== popover) p.classList.remove('show'); });

                // 每次点击下方导航栏的垃圾桶图标展开面板时，重置并隐藏内部的确认遮罩层
                const overlay = document.getElementById('trashConfirmOverlay');
                if (overlay) overlay.classList.remove('show');

                e.stopPropagation(); popover.classList.toggle('show');
            });
            popover.addEventListener('click', (e) => e.stopPropagation());
        }
        setupPopover('moreBtn', 'popoverMenu'); setupPopover('trashBtn', 'trashPopover');

        // 核心修复：悬浮工具栏 (Bubble Menu) 交互驱动逻辑
        const floatingToolbar = document.getElementById('floatingToolbar');
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (!sel.rangeCount || sel.isCollapsed) {
                floatingToolbar.classList.remove('show');
                return;
            }
            const range = sel.getRangeAt(0);
            const container = range.commonAncestorContainer;
            const editor = container.nodeType === 3 ? container.parentNode.closest('.md-editor') : container.closest('.md-editor');
            const titleEditor = container.nodeType === 3 ? container.parentNode.closest('.heading-text') : container.closest('.heading-text');

            // 只有当光标处在编辑状态的 Note 或 Heading 卡片内部，且确实选中了文本时才弹出
            if ((editor && editor.getAttribute('contenteditable') === 'true') || (titleEditor && titleEditor.getAttribute('contenteditable') === 'true')) {
                const rect = range.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    floatingToolbar.style.left = `${rect.left + rect.width / 2}px`;
                    // 优化：Y轴位置上调至 52px，给全新的亮色 UI 留出呼吸空间
                    floatingToolbar.style.top = `${rect.top - 52}px`;
                    floatingToolbar.classList.add('show');
                }
            } else {
                floatingToolbar.classList.remove('show');
            }
        });

                        // 拦截悬浮工具栏的 mousedown，仅用于防止焦点丢失，所有命令移交到 click 处理
        floatingToolbar.addEventListener('mousedown', (e) => {
            if (e.target.id === 'inlineColorPicker') return;
            e.preventDefault(); // 核心：拦截默认行为，保持文本选区不丢失
            e.stopPropagation(); 
        });

        // 🌟 核心重构：将所有指令逻辑绑定在 click，防止与 selectionchange 冲突导致弹窗瞬间闪退！
        floatingToolbar.addEventListener('click', (e) => {
            if (e.target.id === 'inlineColorPicker') return;
            e.preventDefault();
            e.stopPropagation();

            const btn = e.target.closest('.floating-toolbar-btn');
            if (!btn) return;
            const cmd = btn.dataset.cmd;

            const sel = window.getSelection();
            if (!sel.rangeCount) return;

            const node = sel.anchorNode;
            const parent = node.nodeType === 3 ? node.parentNode : node;

            if (cmd === 'bold') document.execCommand('bold', false, null);
            else if (cmd === 'italic') document.execCommand('italic', false, null);
            else if (cmd === 'underline') document.execCommand('underline', false, null);
            
            else if (cmd === 'highlight') {
                const mark = parent.closest('mark');
                if (mark) mark.outerHTML = mark.innerHTML; // 取消高亮
                else if (!sel.isCollapsed) document.execCommand('insertHTML', false, `<mark>${sel.toString()}</mark>\u200B`);
            }
            else if (cmd === 'code') {
                const codeNode = parent.closest('code');
                if (codeNode) codeNode.outerHTML = codeNode.innerHTML; // 取消代码
                else if (!sel.isCollapsed) document.execCommand('insertHTML', false, `<code>${sel.toString()}</code>\u200B`);
            }
            else if (cmd === 'formula') {
                const formulaNode = parent.closest('.inline-formula');
                if (formulaNode) formulaNode.outerHTML = formulaNode.innerHTML; // 取消公式
                else if (!sel.isCollapsed) document.execCommand('insertHTML', false, `<span class="inline-formula" data-formula="${escapeAttribute(sel.toString())}">${escapeHtml(sel.toString())}</span>\u200B`);
            }
            else if (cmd === 'link') {
                const linkNode = parent.closest('a');
                if (linkNode) {
                    linkNode.outerHTML = linkNode.innerHTML; // 再次点击：取消超链接
                } else if (!sel.isCollapsed) {
                    // 🌟 核心机制：记忆当前文字选区（防止弹窗后失焦）
                    const savedRange = sel.getRangeAt(0).cloneRange();
                    const promptOverlay = document.getElementById('customLinkPrompt');
                    const promptInput = document.getElementById('customLinkInput');
                    
                    promptOverlay.classList.add('show');
                    promptInput.value = 'https://';
                    setTimeout(() => { promptInput.focus(); promptInput.select(); }, 50);

                    const cleanup = () => {
                        promptOverlay.classList.remove('show');
                        // 移除事件监听防内存泄漏
                        document.getElementById('customLinkConfirm').replaceWith(document.getElementById('customLinkConfirm').cloneNode(true));
                        document.getElementById('customLinkCancel').replaceWith(document.getElementById('customLinkCancel').cloneNode(true));
                        promptInput.onkeydown = null;
                    };

                    const handleConfirm = () => {
                        const url = promptInput.value.trim();
                        if (url && url !== 'https://') {
                            // 🌟 恢复之前的选区再插入，确保文字位置正确
                            const currentSel = window.getSelection();
                            currentSel.removeAllRanges();
                            currentSel.addRange(savedRange);
                            
                            // 强制 target="_blank" 新标签页打开，且保持主题蓝色无下划线
                            document.execCommand('insertHTML', false, `<a href="${escapeAttribute(url)}" target="_blank" style="color:var(--primary-blue); text-decoration:none; border-bottom:1px solid rgba(91,130,251,0.4);">${escapeHtml(savedRange.toString())}</a>\u200B`);
                            
                            // 触发底层保存
                            const noteEditor = document.querySelector('.note-card.is-editing .md-editor');
                            if (noteEditor) {
                                const card = noteEditor.closest('.note-card');
                                card.dataset.markdown = deriveMarkdownFromHtml(noteEditor.innerHTML);
                                autoGrowNoteCard(card); scheduleSaveState();
                            }
                        }
                        cleanup();
                    };

                    document.getElementById('customLinkConfirm').addEventListener('click', handleConfirm);
                    document.getElementById('customLinkCancel').addEventListener('click', cleanup);
                    promptInput.onkeydown = (e) => {
                        if (e.key === 'Enter') handleConfirm();
                        if (e.key === 'Escape') cleanup();
                    };
                }
            }
            else if (cmd === 'inline-comment') {
                const commentNode = parent.closest('.inline-comment');
                if (commentNode) {
                    const linkedCard = document.querySelector(`.comment-card[data-parent-card-id="${commentNode.id}"]`);
                    if (linkedCard) linkedCard.remove();
                    commentNode.outerHTML = commentNode.innerHTML; 
                } else if (!sel.isCollapsed) {
                    const text = sel.toString();
                    const spanId = 'inline-comment-' + Date.now();
                    document.execCommand('insertHTML', false, `<span class="inline-comment" id="${spanId}" style="border-bottom: 2px dashed #f59e0b; background: rgba(245,158,11,0.1); cursor: pointer;" title="点击查看/回复评论">${escapeHtml(text)}</span>\u200B`);
                    
                    const newSpan = document.getElementById(spanId);
                    if (newSpan) {
                        const parentCard = newSpan.closest('.card');
                        if (parentCard) {
                            const rect = parentCard.getBoundingClientRect();
                            const vpRect = viewport.getBoundingClientRect();
                            const cx = (rect.right - vpRect.left - panX + 20) / scale;
                            const cy = (rect.top - vpRect.top - panY) / scale;
                            const commentCard = createCommentCard(cx, cy);
                            commentCard.dataset.parentCardId = spanId;
                            commentCard.classList.add('comment-popover-mode');
                            toggleCommentPopover(parentCard, commentCard);
                            scheduleSaveState();
                        }
                    }
                }
            }
            else if (cmd === 'h2') {
                const block = node.nodeType === 3 ? node.parentNode.closest('h2') : node.closest('h2');
                if (block) document.execCommand('formatBlock', false, 'DIV');
                else document.execCommand('formatBlock', false, 'H2');
            }
            else if (cmd === 'quote') {
                const block = node.nodeType === 3 ? node.parentNode.closest('blockquote') : node.closest('blockquote');
                if (block) document.execCommand('formatBlock', false, 'DIV');
                else document.execCommand('formatBlock', false, 'BLOCKQUOTE');
            }
            else if (cmd === 'sizeUp' || cmd === 'sizeDown') {
                const titleCard = document.querySelector('.heading-card.is-editing');
                if (titleCard) {
                    const textEl = titleCard.querySelector('.heading-text');
                    let currentSize = parseInt(window.getComputedStyle(textEl).fontSize) || 28;
                    currentSize += cmd === 'sizeUp' ? 4 : -4;
                    textEl.style.fontSize = Math.max(12, currentSize) + 'px';
                    scheduleSaveState();
                }
                const noteCard = document.querySelector('.note-card.is-editing');
                if (noteCard) {
                    const editor = noteCard.querySelector('.md-editor');
                    const sel = window.getSelection();
                    if (sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) {
                        const range = sel.getRangeAt(0);
                        const container = range.commonAncestorContainer;
                        const el = container.nodeType === 3 ? container.parentNode : container;
                        const computedSize = parseFloat(window.getComputedStyle(el).fontSize);
                        const delta = cmd === 'sizeUp' ? 2 : -2;
                        const newSize = Math.max(8, computedSize + delta);
                        const span = document.createElement('span');
                        span.style.fontSize = newSize + 'px';
                        try {
                            range.surroundContents(span);
                        } catch (_) {
                            const fragment = range.extractContents();
                            span.appendChild(fragment);
                            range.insertNode(span);
                        }
                        noteCard.dataset.markdown = deriveMarkdownFromHtml(editor.innerHTML);
                        autoGrowNoteCard(noteCard);
                        scheduleSaveState();
                    }
                }
            }

            const noteEditor = document.querySelector('.note-card.is-editing .md-editor');
            if (noteEditor) {
                const card = noteEditor.closest('.note-card');
                card.dataset.markdown = deriveMarkdownFromHtml(noteEditor.innerHTML);
                autoGrowNoteCard(card); scheduleSaveState();
            }
        });

        // 核心新增：监听文本内联颜色的变化并执行渲染
        const inlineColorPicker = document.getElementById('inlineColorPicker');
        if (inlineColorPicker) {
            inlineColorPicker.addEventListener('input', (e) => {
                document.execCommand('foreColor', false, e.target.value);
                const noteEditor = document.querySelector('.note-card.is-editing .md-editor');
                if (noteEditor) {
                    const card = noteEditor.closest('.note-card');
                    card.dataset.markdown = deriveMarkdownFromHtml(noteEditor.innerHTML);
                    scheduleSaveState();
                }
            });
        }

        const contextMenu = document.getElementById('contextMenu');
        let rightClickedCard = null;
        let cardClipboard = []; // 🌟 核心新增：全局白板剪贴板变量

        // 1. 全局点击事件：隐藏各类弹窗及选中连线
        document.addEventListener('click', (e) => {
            document.getElementById('popoverMenu').classList.remove('show');
            document.getElementById('trashPopover').classList.remove('show');
            const settingsPopover = document.getElementById('settingsPopover');
            if (settingsPopover) settingsPopover.classList.remove('show');
            if (contextMenu) contextMenu.classList.remove('show');

            // 点击空白处时隐藏悬浮连线工具栏
            const flt = document.getElementById('floatingLineToolbar');
            if (flt && !e.target.closest('#floatingLineToolbar') && !e.target.closest('.line-group')) {
                flt.classList.remove('show');
            }

            if (!e.target.closest('.transfer-drawer') && !e.target.closest('#transferBtn') && !e.target.closest('#templateBtn')) { 
            if (transferDrawer.classList.contains('open')) toggleTransferDrawer(); 
            if (typeof templateDrawer !== 'undefined' && templateDrawer.classList.contains('open')) toggleTemplateDrawer();
        }
        if (hasDraggedBox) return;

                        // (行内评论触发逻辑已转移至更底层的 card.click 侦听器中，此处废弃移除)

            // 🌟 核心新增：点击外部时自动折叠收起所有弹出的评论卡片
            if (!e.target.closest('.comment-card') && !e.target.closest('.card-comment-badge') && !e.target.closest('.inline-comment')) {
                document.querySelectorAll('.comment-card.comment-popover-mode.show').forEach(c => {
                    c.classList.remove('show');
                    c.classList.remove('is-editing');
                });
            }

            // 左键选中连线
            const lineGroup = e.target.closest('.line-group');
            if (lineGroup) {
                e.stopPropagation();
                clearCardSelection();
                selectedLineId = lineGroup.dataset.lineId;
                renderLines();
                if (typeof updateLineToolbar === 'function') updateLineToolbar(e);
                return;
            }
            if (e.target.classList.contains('line-label')) return;
        }); // <--- 之前就是丢了这个极其关键的结尾！

        // 2. 悬浮连线工具栏的独立事件绑定
        const floatingLineToolbar = document.getElementById('floatingLineToolbar');
        if (floatingLineToolbar) {
            // 监听悬浮栏内的自定义原生色彩面板
            const picker = floatingLineToolbar.querySelector('.line-color-picker');
            if (picker) {
                picker.addEventListener('input', (e) => {
                    if (selectedLineId) {
                        const line = lines.find(l => l.id === selectedLineId);
                        if (line) {
                            line.color = e.target.value;
                            renderLines(); if (typeof updateLineToolbar === 'function') updateLineToolbar(); scheduleSaveState();
                        }
                    }
                });
            }

            floatingLineToolbar.addEventListener('mousedown', e => e.preventDefault());
            floatingLineToolbar.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止点击菜单时触发全屏关闭
                if (!selectedLineId) return;
                const line = lines.find(l => l.id === selectedLineId);
                if (!line) return;

                const colorDot = e.target.closest('.line-color-dot');
                if (colorDot) {
                    line.color = colorDot.dataset.color;
                } else {
                    const btn = e.target.closest('.floating-toolbar-btn');
                    if (!btn) return;
                    if (btn.classList.contains('line-type-btn')) line.type = btn.dataset.type;
                    if (btn.classList.contains('line-style-btn')) line.style = btn.dataset.style;
                    if (btn.classList.contains('line-weight-btn')) line.weight = parseInt(btn.dataset.weight);
                    if (btn.classList.contains('line-arrow-btn')) line.arrow = btn.dataset.arrow;
                    if (btn.classList.contains('line-label-btn')) {
                        const labelDiv = document.querySelector(`.line-label[data-line-id="${selectedLineId}"]`);
                        if (labelDiv) {
                            labelDiv.style.display = 'block';
                            setTimeout(() => { labelDiv.focus(); window.getSelection().selectAllChildren(labelDiv); }, 50);
                        }
                    }
                }

                renderLines(); if (typeof updateLineToolbar === 'function') updateLineToolbar(); scheduleSaveState();
            });
        }

        function ensureCommentBadge(parentCard, commentCard) {
            let badge = parentCard.querySelector('.card-comment-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'card-comment-badge';
                badge.innerHTML = '0'; // 纯数字内容
                parentCard.appendChild(badge);

                badge.addEventListener('mousedown', (e) => {
                    e.stopPropagation(); // 阻止画布拖拽
                    toggleCommentPopover(parentCard, commentCard);
                });
            }

            const list = commentCard.querySelector('.comment-list');
            if (list) {
                const updateCount = () => {
                    const count = list.querySelectorAll('.comment-msg').length;
                    badge.innerText = count;
                    badge.setAttribute('data-count', count);

                    // 只有在弹窗模式下才需要这个逻辑
                    if (count === 0 && !commentCard.classList.contains('show')) {
                        badge.style.display = 'none';
                    } else {
                        badge.style.display = 'flex';
                    }
                };
                // 确保防抖和单例绑定
                if (commentCard._commentObserver) commentCard._commentObserver.disconnect();
                commentCard._commentObserver = new MutationObserver(updateCount);
                commentCard._commentObserver.observe(list, { childList: true });
                updateCount();
            }
        }

        function toggleCommentPopover(parentCard, commentCard) {
            const isShowing = commentCard.classList.contains('show');

            // 折叠其它正在打开的评论弹窗，保持画布视觉清爽
            document.querySelectorAll('.comment-card.comment-popover-mode.show').forEach(c => {
                if (c !== commentCard) c.classList.remove('show');
            });

            if (!isShowing) {
                // 动态计算精准的弹出位置（在右上角定位徽章的右侧，随缩放自适应）
                const parentRect = parentCard.getBoundingClientRect();
                const vpRect = viewport.getBoundingClientRect();
                const cx = (parentRect.right - vpRect.left - panX + 25) / scale;
                const cy = (parentRect.top - vpRect.top - panY - 20) / scale;

                commentCard.style.left = `${cx}px`;
                commentCard.style.top = `${cy}px`;
                commentCard.classList.add('show');

                // 强制临时提升层级，盖住周围的卡片
                commentCard.style.zIndex = parseInt(window.getComputedStyle(parentCard).zIndex || 10) + 100;

                                setTimeout(() => {
                    const input = commentCard.querySelector('.comment-input-box input');
                    if (input) {
                        // 🌟 取消粗暴的 clearCardSelection，只去除其他卡片的 selected，但不破坏选区
                        document.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
                        commentCard.classList.add('selected');
                        commentCard.classList.add('is-editing');
                        input.focus();
                    }
                }, 50);
            } else {
                commentCard.classList.remove('show');
                commentCard.classList.remove('is-editing');
            }
        }

        document.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (e.target.closest('.sidebar') || e.target.closest('.note-toolbar') || e.target.closest('.floating-toolbar')) return;

            // 右键选中连线
            const lineGroup = e.target.closest('.line-group');
            if (lineGroup) {
                clearCardSelection();
                selectedLineId = lineGroup.dataset.lineId;
                renderLines();
                rightClickedCard = null;
            } else {
                const card = e.target.closest('.card');
                if (card) {
                    rightClickedCard = card;
                    if (!card.classList.contains('selected')) {
                        clearCardSelection();
                        card.classList.add('selected');
                        updateNoteToolbar(card.classList.contains('note-card') ? card : null);
                        updateBoardToolbar(card.classList.contains('board-card') ? card : null);
                    }
                } else {
                    rightClickedCard = null;
                }
            }

            // 每次重新右键呼出菜单时，清理可能残留的悬停焦点锁
            contextMenu.querySelectorAll('.ctx-has-submenu.keep-open').forEach(sub => sub.classList.remove('keep-open'));

            // 🌟 核心新增：审查时间 (Last Modified) UI 动态刷新
            const ctxLastModified = document.getElementById('ctxLastModified');
            if (ctxLastModified) {
                if (rightClickedCard && rightClickedCard.dataset.lastModified) {
                    const date = new Date(parseInt(rightClickedCard.dataset.lastModified));
                    const timeStr = date.toLocaleDateString() + ' ' + date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
                    ctxLastModified.innerHTML = `<i class="fa-regular fa-clock"></i> 修改于: ${timeStr}`;
                    ctxLastModified.style.display = 'flex';
                } else if (rightClickedCard) {
                    ctxLastModified.innerHTML = `<i class="fa-regular fa-clock"></i> 修改于: 刚刚`;
                    ctxLastModified.style.display = 'flex';
                } else {
                    ctxLastModified.style.display = 'none';
                }
            }

            // 核心修复：必须先让菜单 display: block，才能获取到它真实的物理宽高
            contextMenu.classList.add('show');
            contextMenu.classList.remove('open-left'); // 重置向左展开的标识

            // 动态计算边界，防止菜单被屏幕底部或右侧遮挡
            const menuWidth = contextMenu.offsetWidth;
            const menuHeight = contextMenu.offsetHeight;
            let posX = e.clientX;
            let posY = e.clientY;

            // 1. 检查右侧边界：如果溢出，菜单向左偏移，并打上 open-left 标记让子菜单也向左弹
            if (posX + menuWidth > window.innerWidth) {
                posX = window.innerWidth - menuWidth - 8; // 留出 8px 安全边距
                contextMenu.classList.add('open-left');
            }

            // 2. 检查底部边界：如果溢出，菜单改为向上弹出
            if (posY + menuHeight > window.innerHeight) {
                posY = window.innerHeight - menuHeight - 8;
            }

            contextMenu.style.left = `${posX}px`;
            contextMenu.style.top = `${posY}px`;
        });

        // 核心新增：统一封装色彩渲染分发器
        function applyCtxColor(color, prop) {
            if (selectedLineId && prop === 'accent') {
                const line = lines.find(l => l.id === selectedLineId);
                if (line) line.color = color;
                renderLines();
            } else {
                // 核心修复：获取所有被选中的卡片，支持批量修改颜色
                let targets = Array.from(document.querySelectorAll('.card.selected'));
                // 如果没有多选，但存在右键点击的目标，则只针对右键目标
                if (targets.length === 0 && rightClickedCard) targets = [rightClickedCard];

                targets.forEach(card => {
                    if (card.classList.contains('note-card')) {
                        const appearance = getNoteCardAppearance(card);
                        if (prop === 'accent') applyNoteAppearance(card, color, appearance.backgroundColor);
                        else applyNoteAppearance(card, appearance.accentColor, color);
                    } else {
                        if (prop === 'accent') card.style.borderTopColor = color;
                        else card.style.backgroundColor = color;
                    }
                });
            }
            scheduleSaveState();
        }

        // 🌟 核心升级：采用物理引擎 (力导向图 Force-Directed Graph) + 碰撞箱检测，完美解决重叠与环状循环问题
        function tidyUpConnections() {
            const currentBoard = getActiveBoard();
            
            // 1. 找到当前画板上所有真实有效的连线
            const validLines = lines.filter(l => {
                const f = document.getElementById(l.from);
                const t = document.getElementById(l.to);
                return f && t && f.dataset.boardId === currentBoard && t.dataset.boardId === currentBoard && !f.classList.contains('nested-card') && !t.classList.contains('nested-card');
            });

            if (validLines.length === 0) {
                if (typeof showToast === 'function') showToast('当前画板没有可整理的连线网络', 'warning');
                return;
            }

            // 2. 提取参与连线的所有节点，获取其物理尺寸
            const nodeSet = new Set();
            validLines.forEach(l => { nodeSet.add(l.from); nodeSet.add(l.to); });

            const nodes = [];
            const nodeMap = {};
            let cx = 0, cy = 0;

            nodeSet.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    const n = {
                        id: id, el: el,
                        x: parseFloat(el.style.left) || 0,
                        y: parseFloat(el.style.top) || 0,
                        w: el.offsetWidth || 300,
                        h: el.offsetHeight || 200,
                        vx: 0, vy: 0
                    };
                    nodes.push(n);
                    nodeMap[id] = n;
                    cx += n.x + n.w / 2;
                    cy += n.y + n.h / 2;
                }
            });

            // 计算整个群落的初始几何中心，用于施加向心引力，防止节点飞走
            cx /= nodes.length;
            cy /= nodes.length;

            // 🌟 3. 物理模拟循环 (深度优化版：大间距、强排斥、清晰逻辑流)
            const iterations = 300; 
            const idealDist = 550; // 🌟 增加水平间距，让逻辑线条拉长，更易观察
            let temp = 200; 

            for (let iter = 0; iter < iterations; iter++) {
                // A. 增强版库仑排斥
                for (let i = 0; i < nodes.length; i++) {
                    nodes[i].vx = 0; nodes[i].vy = 0;
                    for (let j = 0; j < nodes.length; j++) {
                        if (i !== j) {
                            const v = nodes[i], u = nodes[j];
                            let dx = (v.x + v.w / 2) - (u.x + u.w / 2);
                            let dy = (v.y + v.h / 2) - (u.y + u.h / 2);

                            if (Math.abs(dy) < 1) dy = (Math.random() - 0.5) * 40;
                            if (Math.abs(dx) < 1) dx = (Math.random() - 0.5) * 40;

                            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                            // 🌟 提升基础排斥系数，并大幅增加垂直权重 (3.5倍)，迫使卡片垂直散开，不让线叠在一起
                            const force = 180000 / (dist * dist); 
                            v.vx += (dx / dist) * force;
                            v.vy += (dy / dist) * force * 3.5; 
                        }
                    }
                }

                // B. 柔性流向风场
                validLines.forEach(l => {
                    const v = nodeMap[l.from];
                    const u = nodeMap[l.to];
                    if (v && u) {
                        let dx = (u.x + u.w / 2) - (v.x + v.w / 2);
                        let dy = (u.y + u.h / 2) - (v.y + v.h / 2);
                        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

                        const springTension = 0.08;
                        const springForce = (dist - idealDist) * springTension;
                        u.vx -= (dx / dist) * springForce;
                        u.vy -= (dy / dist) * springForce;
                        v.vx += (dx / dist) * springForce;
                        v.vy += (dy / dist) * springForce;

                        // 🌟 逻辑向右风场：如果子节点在父节点左侧或过近，施加强力推向右侧
                        if (dx < idealDist * 0.9) {
                            u.vx += 25; 
                            v.vx -= 25; 
                        }
                    }
                });

                // C. 全局向心力与 D. 坐标更新
                nodes.forEach(n => {
                    n.vx += (cx - (n.x + n.w / 2)) * 0.01;
                    n.vy += (cy - (n.y + n.h / 2)) * 0.02;
                    const d = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1;
                    n.x += (n.vx / d) * Math.min(d, temp);
                    n.y += (n.vy / d) * Math.min(d, temp);
                });
                temp *= 0.96;
            }

            // 4. 增强型刚体碰撞箱 (Double Buffer)
            for (let iter = 0; iter < 15; iter++) {
                for (let i = 0; i < nodes.length; i++) {
                    for (let j = i + 1; j < nodes.length; j++) {
                        const a = nodes[i], b = nodes[j];
                        const padX = 120; // 🌟 翻倍水平呼吸空间
                        const padY = 80;  // 🌟 翻倍垂直呼吸空间
                        
                        const overlapX = Math.min(a.x + a.w + padX, b.x + b.w + padX) - Math.max(a.x - padX, b.x - padX);
                        const overlapY = Math.min(a.y + a.h + padY, b.y + b.h + padY) - Math.max(a.y - padY, b.y - padY);

                        if (overlapX > 0 && overlapY > 0) {
                            const shift = (overlapX < overlapY ? overlapX : overlapY) / 2;
                            const factor = overlapX < overlapY ? 'x' : 'y';
                            if (a[factor] < b[factor]) { a[factor] -= shift; b[factor] += shift; } 
                            else { a[factor] += shift; b[factor] -= shift; }
                        }
                    }
                }
            }

            // 🌟 终极美化：加大网格对齐颗粒度，让排版更显得“方正、规整”
            nodes.forEach(n => {
                n.x = Math.round(n.x / 50) * 50;
                n.y = Math.round(n.y / 30) * 30;
            });

            // 5. 应用最终坐标并触发平滑动画
            nodes.forEach(n => {
                n.el.classList.add('is-tidying');
                n.el.style.left = n.x + 'px';
                n.el.style.top = n.y + 'px';
                setTimeout(() => n.el.classList.remove('is-tidying'), 550);
            });

            // 6. 开启高频帧循环渲染连线，营造极致丝滑的跟随效果
            let startTime = Date.now();
            const anim = () => {
                renderLines();
                if (Date.now() - startTime < 550) {
                    requestAnimationFrame(anim);
                } else {
                    updateMinimap(); scheduleSaveState();
                }
            };
            requestAnimationFrame(anim);
        }

        contextMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = e.target.closest('.ctx-item');
            const colorDot = e.target.closest('.ctx-color-dot');

            // 预设圆点点击
            if (colorDot) {
                const color = colorDot.dataset.color;
                const prop = colorDot.closest('.ctx-color-grid').dataset.targetProp || 'accent';
                applyCtxColor(color, prop);
                contextMenu.classList.remove('show');
                return;
            }

            if (e.target.closest('.ctx-submenu')) return;
            if (!item) return;

            const action = item.dataset.action;
            // 处理撤销和重做菜单点击
            if (action === 'undo') {
                performUndo();
            } else if (action === 'redo') {
                performRedo();
            } else if (action === 'copy') {
                const targets = document.querySelectorAll('.card.selected').length > 0
                    ? Array.from(document.querySelectorAll('.card.selected'))
                    : (rightClickedCard ? [rightClickedCard] : []);
                if (targets.length > 0) {
                    cardClipboard = targets.map(c => serializeCard(c, false));
                    // 单张图片卡片：把图片数据写入系统剪贴板
                    if (targets.length === 1 && targets[0].dataset.type === 'image') {
                        const img = targets[0].querySelector('img');
                        if (img && img.src) {
                            fetch(img.src).then(r => r.blob()).then(blob => {
                                try { navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]); } catch(_) {}
                            }).catch(() => {});
                        }
                    }
                    if (typeof showToast === 'function') showToast(`已复制 ${targets.length} 张卡片`, 'success');
                }
            } else if (action === 'paste') {
                // 🌟 核心新增：精准贴合在鼠标呼出右键菜单的坐标位置
                if (cardClipboard.length > 0) {
                    clearCardSelection();
                    const rect = viewport.getBoundingClientRect();
                    const menuLeft = parseFloat(contextMenu.style.left) || e.clientX;
                    const menuTop = parseFloat(contextMenu.style.top) || e.clientY;
                    const pasteX = (menuLeft - rect.left - panX) / scale;
                    const pasteY = (menuTop - rect.top - panY) / scale;

                    let minX = Infinity, minY = Infinity;
                    cardClipboard.forEach(c => {
                        if (c.x < minX) minX = c.x;
                        if (c.y < minY) minY = c.y;
                    });

                    cardClipboard.forEach(state => {
                        const newState = JSON.parse(JSON.stringify(state));
                        newState.id = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                        newState.x = pasteX + (state.x - minX);
                        newState.y = pasteY + (state.y - minY);
                        const newCard = restoreCardFromState(newState, null);
                        if (newCard) newCard.classList.add('selected');
                    });
                    updateMinimap(); scheduleSaveState();
                } else {
                    if (typeof showToast === 'function') showToast('剪贴板为空，请先复制', 'warning');
                }
                        } else if (action === 'duplicate') {
                // 🌟 核心新增：原地位移克隆
                const targets = document.querySelectorAll('.card.selected').length > 0
                    ? Array.from(document.querySelectorAll('.card.selected'))
                    : (rightClickedCard ? [rightClickedCard] : []);
                if (targets.length > 0) {
                    clearCardSelection();
                    targets.forEach(c => {
                        const state = serializeCard(c, false);
                        state.id = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                        state.x += 40; // 偏移 40 像素营造层叠感
                        state.y += 40;
                        const newCard = restoreCardFromState(state, null);
                        if (newCard) newCard.classList.add('selected');
                    });
                    updateMinimap(); scheduleSaveState();
                    if (typeof showToast === 'function') showToast(`已克隆 ${targets.length} 张卡片`, 'success');
                }
            } else if (action === 'addComment' && rightClickedCard) {
                // 🌟 核心修复：确保父级卡片拥有唯一 ID，防止删除时找不到绑定关系
                if (!rightClickedCard.id) {
                    rightClickedCard.id = 'card-' + Date.now() + Math.floor(Math.random() * 100000);
                }
                
                // 🌟 核心新增：Milanote 风格无缝子属弹窗绑定
                let commentCard = document.querySelector(`.comment-card[data-parent-card-id="${rightClickedCard.id}"]`);

                if (!commentCard) {
                    const rect = rightClickedCard.getBoundingClientRect();
                    const vpRect = viewport.getBoundingClientRect();
                    const cx = (rect.right - vpRect.left - panX + 20) / scale;
                    const cy = (rect.top - vpRect.top - panY) / scale;

                    commentCard = createCommentCard(cx, cy);
                    // 打上绑定关系的钢印
                    commentCard.dataset.parentCardId = rightClickedCard.id;
                    commentCard.classList.add('comment-popover-mode');

                    ensureCommentBadge(rightClickedCard, commentCard);
                    scheduleSaveState();
                }

                toggleCommentPopover(rightClickedCard, commentCard);
            } else if (action === 'tidyUp') {
                tidyUpConnections(); // 核心：触发拓扑整理算法
            } else if (action === 'sendToTransfer') {
                sendSelectedToTransfer(); // 发送到中转站
            } else if (action === 'delete') {
                if (selectedLineId) {
                    lines = lines.filter(l => l.id !== selectedLineId);
                    selectedLineId = null;
                    renderLines();
                    scheduleSaveState();
                } else {
                    deleteSelectedCards();
                }
            } else if (action === 'bringFront' && rightClickedCard) {
                rightClickedCard.style.zIndex = parseInt(window.getComputedStyle(rightClickedCard).zIndex || 10) + 10;
                scheduleSaveState();
            } else if (action === 'sendBack' && rightClickedCard) {
                rightClickedCard.style.zIndex = 1;
                scheduleSaveState();
            } else if (action === 'lock' && rightClickedCard) {
                rightClickedCard.classList.toggle('locked');
                scheduleSaveState();
            }

            contextMenu.classList.remove('show');
        });
        // 在 contextMenu.addEventListener 后面插入：
        // 核心新增：监听原生色彩面板的拖动，实现实时预览和保存
        document.querySelectorAll('.ctx-color-picker').forEach(picker => {
            // 核心修复：点击颜色面板的瞬间，给父级菜单强行上锁，无视系统对话框导致的焦点丢失
            picker.addEventListener('click', (e) => {
                const submenu = e.target.closest('.ctx-has-submenu');
                if (submenu) submenu.classList.add('keep-open');
            });

            picker.addEventListener('input', (e) => {
                const color = e.target.value;
                const prop = e.target.closest('.ctx-color-grid').dataset.targetProp || 'accent';
                applyCtxColor(color, prop);
            });

            // 系统选色面板关闭时，自动解除锁并隐藏菜单
            picker.addEventListener('change', (e) => {
                const submenu = e.target.closest('.ctx-has-submenu');
                if (submenu) submenu.classList.remove('keep-open');
                contextMenu.classList.remove('show');
            });
        });

        document.addEventListener('click', (e) => {
            document.getElementById('popoverMenu').classList.remove('show');
            document.getElementById('trashPopover').classList.remove('show');
            if (contextMenu) contextMenu.classList.remove('show');

            // 点击空白处时隐藏悬浮连线工具栏
            const flt = document.getElementById('floatingLineToolbar');
            if (flt && !e.target.closest('#floatingLineToolbar') && !e.target.closest('.line-group')) {
                flt.classList.remove('show');
            }

            if (!e.target.closest('.transfer-drawer') && !e.target.closest('#transferBtn') && !e.target.closest('#templateBtn')) { 
            if (transferDrawer.classList.contains('open')) toggleTransferDrawer(); 
            if (typeof templateDrawer !== 'undefined' && templateDrawer.classList.contains('open')) toggleTemplateDrawer();
        }
        if (hasDraggedBox) return;
        });

        const trashTabs = document.querySelectorAll('.trash-tab');
        trashTabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                trashTabs.forEach(t => t.classList.remove('active')); document.querySelectorAll('.trash-content').forEach(c => c.classList.add('hidden'));
                e.currentTarget.classList.add('active'); document.getElementById(e.currentTarget.getAttribute('data-target')).classList.remove('hidden');
            });
        });

        if (!restoreWorkspaceState()) {
            refreshBoardVisibility();
            centerViewportOnActiveBoard();
            saveWorkspaceState(); // 强行触发首次保存，初始化底层状态
        } else {
            currentStateStr = localStorage.getItem(STORAGE_KEY);
        }

        checkTrashEmptyState();
        if (typeof checkTransferEmptyState === 'function') checkTransferEmptyState();
        updateMinimap();
        updateNoteToolbar();


        // ================= 核心新增：画板结构树 (Board Tree) 引擎 =================
        const treeDrawer = document.getElementById('treeDrawer');
        const treeBtn = document.getElementById('treeBtn');
        const closeTreeBtn = document.getElementById('closeTreeBtn');

                function toggleTreeDrawer() {
            treeDrawer.classList.toggle('open');
            const icon = treeBtn.querySelector('i');
            const toolIcon = treeBtn.querySelector('.tool-icon');
            if (treeDrawer.classList.contains('open')) {
                icon.className = 'fa-solid fa-xmark';
                toolIcon.style.backgroundColor = 'var(--primary-blue)';
                toolIcon.style.color = '#fff';
                renderBoardTree();
            } else {
                icon.className = 'fa-solid fa-folder-tree';
                toolIcon.style.backgroundColor = 'var(--card-bg)';
                toolIcon.style.color = '';
            }
        }

        if (treeBtn) treeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleTreeDrawer(); });
        if (closeTreeBtn) closeTreeBtn.addEventListener('click', (e) => { e.stopPropagation(); if(treeDrawer.classList.contains('open')) toggleTreeDrawer(); });
        treeDrawer.addEventListener('mousedown', e => e.stopPropagation());

        function renderBoardTree() {
            const container = document.getElementById('treeContent');
            if (!container) return;

            // 用于从各类卡片中抓取大纲摘要文字
            function getTreeCardText(card) {
                const type = card.dataset.type;
                if (type === 'heading') return card.querySelector('.heading-text')?.innerText || '标题';
                if (type === 'note') return card.querySelector('.md-editor')?.innerText.split('\n')[0] || '笔记';
                if (type === 'todo') return '待办事项';
                if (type === 'column') return card.querySelector('.column-title')?.innerText || '收纳列';
                if (type === 'file') return card.dataset.filename || '文件';
                if (type === 'link') return getLinkCardLabel(card);
                if (type === 'caption') return '视频字幕';
                if (type === 'table') return '表格';
                if (type === 'image') return '图片';
                if (type === 'comment') return '评论';
                return '卡片';
            }

            // 匹配大纲左侧的专属图标
            function getTreeIconForType(type) {
                switch(type) {
                    case 'note': return 'fa-solid fa-bars';
                    case 'heading': return 'fa-solid fa-heading';
                    case 'todo': return 'fa-solid fa-list-check';
                    case 'column': return 'fa-solid fa-columns';
                    case 'link': return 'fa-solid fa-link';
                    case 'image': return 'fa-regular fa-image';
                    case 'file': return 'fa-regular fa-file';
                    case 'caption': return 'fa-solid fa-closed-captioning';
                    case 'table': return 'fa-solid fa-table';
                    case 'comment': return 'fa-regular fa-comment-dots';
                    default: return 'fa-regular fa-note-sticky';
                }
            }

            // 递归构建树节点HTML
            function buildTreeNode(boardId) {
                let title = '根目录 (Root)';
                if (boardId !== ROOT_BOARD_ID) {
                    const b = document.getElementById(boardId);
                    if (!b) return '';
                    title = b.querySelector('.board-title').innerText;
                }

                const isActive = boardId === getActiveBoard();
                let html = `<div class="tree-node board-tree-node ${isActive ? 'active' : ''}" data-id="${boardId}">
                    <i class="fa-solid ${boardId === ROOT_BOARD_ID ? 'fa-layer-group' : 'fa-folder-open'}"></i>
                    <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(title)}</span>
                </div>`;

                // 核心修复：不但寻找子画板，同时也把当前空间下的普通卡片全拉取出来
                const childBoards = Array.from(document.querySelectorAll(`.board-card[data-board-id="${boardId}"]`));
                const childCards = Array.from(document.querySelectorAll(`.card:not(.nested-card):not(.board-card)[data-board-id="${boardId}"]`));

                if (childBoards.length > 0 || childCards.length > 0) {
                    html += `<div class="tree-children">`;
                    // 1. 优先渲染子画板目录
                    childBoards.forEach(child => { html += buildTreeNode(child.id); });

                    // 2. 将普通卡片附着在画板的树形节点下
                    childCards.forEach(child => {
                        let text = getTreeCardText(child).trim();
                        if (!text) text = '未命名卡片';
                        html += `<div class="tree-node card-tree-node" data-card-id="${child.id}">
                            <i class="${getTreeIconForType(child.dataset.type)}"></i>
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size: 11.5px; color: var(--text-secondary);">${escapeHtml(text)}</span>
                        </div>`;
                    });
                    html += `</div>`;
                }
                return html;
            }

            container.innerHTML = buildTreeNode(ROOT_BOARD_ID);

            // 绑定：画板目录点击 (上帝视角的传送门)
            container.querySelectorAll('.board-tree-node').forEach(node => {
                node.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const targetId = e.currentTarget.dataset.id;
                    if (targetId === getActiveBoard()) return;

                    const newPath = [];
                    let curr = targetId;
                    while (curr !== ROOT_BOARD_ID) {
                        newPath.unshift(curr);
                        const el = document.getElementById(curr);
                        if (el) {
                            curr = el.dataset.boardId;
                        } else {
                            break;
                        }
                    }
                    newPath.unshift(ROOT_BOARD_ID);

                    boardStack = newPath;

                    updateBreadcrumbs();
                    refreshBoardVisibility();
                    centerViewportOnActiveBoard();
                    renderBoardTree();
                });
            });

            // 绑定：卡片大纲点击 (跨越层级追踪定位，并带呼吸高亮灯)
            container.querySelectorAll('.card-tree-node').forEach(node => {
                node.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const cardId = e.currentTarget.dataset.cardId;
                    const card = document.getElementById(cardId);
                    if (!card) return;

                    const targetBoardId = card.dataset.boardId || ROOT_BOARD_ID;

                    // 如果卡片在另一个深层空间，先重写宇宙时间线并切过去
                    if (targetBoardId !== getActiveBoard()) {
                        const newPath = [];
                        let curr = targetBoardId;
                        while (curr && curr !== ROOT_BOARD_ID) {
                            newPath.unshift(curr);
                            const el = document.getElementById(curr);
                            if (el) curr = el.dataset.boardId;
                            else break;
                        }
                        newPath.unshift(ROOT_BOARD_ID);
                        boardStack = newPath;

                        if(typeof updateBreadcrumbs === 'function') updateBreadcrumbs();
                        refreshBoardVisibility();
                        renderBoardTree();
                    }

                    // 镜头平滑居中，并打上高亮呼吸灯
                    requestAnimationFrame(() => {
                        clearCardSelection();
                        card.classList.add('selected');
                        card.classList.add('search-highlight');
                        setTimeout(() => card.classList.remove('search-highlight'), 3000);

                        const cx = parseFloat(card.style.left) || 0;
                        const cy = parseFloat(card.style.top) || 0;
                        const w = parseFloat(card.style.width) || card.offsetWidth || 150;
                        const h = parseFloat(card.style.height) || card.offsetHeight || 100;

                        const vpRect = viewport.getBoundingClientRect();
                        panX = vpRect.width / 2 - (cx + w / 2) * scale;
                        panY = vpRect.height / 2 - (cy + h / 2) * scale;

                        if (typeof applyTransform === 'function') applyTransform();
                    });
                });
            });
        }

        // 确保更改画板名字时树结构会同步（挂载在画板 title 的失焦事件上）
        document.addEventListener('blur', (e) => {
            if (e.target.classList.contains('board-title')) {
                updateBreadcrumbs();
                if (treeDrawer.classList.contains('open')) renderBoardTree();
            }
        }, true);



        // ================= 优化增强模块 =================
        // 这部分是在原代码之后追加的增强功能，不影响原有逻辑。

        // --- 1. Toast 通知系统：替代原生 alert ---
        (function initToastSystem() {
            const style = document.createElement('style');
            style.textContent = `
                .toast-container { position: fixed; top: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
                .toast { background: #2d3748; color: #fff; padding: 12px 18px; border-radius: 8px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); display: flex; align-items: center; gap: 10px; min-width: 240px; max-width: 400px; pointer-events: auto; animation: toastSlide 0.25s ease-out; }
                .toast.toast-success { background: #10b981; }
                .toast.toast-error { background: #ef4444; }
                .toast.toast-warning { background: #f59e0b; }
                .toast.toast-info { background: #3b82f6; }
                .toast-close { margin-left: auto; cursor: pointer; opacity: 0.7; padding: 0 4px; }
                .toast-close:hover { opacity: 1; }
                .toast.toast-hiding { animation: toastHide 0.2s ease-in forwards; }
                @keyframes toastSlide { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
                @keyframes toastHide { to { transform: translateX(120%); opacity: 0; } }
            `;
            document.head.appendChild(style);
            const container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);

            window.showToast = function(message, type = 'info', duration = 3000) {
                const toast = document.createElement('div');
                toast.className = `toast toast-${type}`;
                const icons = { success: 'check-circle', error: 'circle-exclamation', warning: 'triangle-exclamation', info: 'circle-info' };
                toast.innerHTML = `<i class="fa-solid fa-${icons[type] || 'circle-info'}"></i><span>${message}</span><span class="toast-close"><i class="fa-solid fa-xmark"></i></span>`;
                container.appendChild(toast);
                const close = () => { toast.classList.add('toast-hiding'); setTimeout(() => toast.remove(), 200); };
                toast.querySelector('.toast-close').addEventListener('click', close);
                if (duration > 0) setTimeout(close, duration);
                return toast;
            };

            // 覆盖原生 alert 为 toast (可选，如要保留原生弹窗可注释这段)
            window._origAlert = window.alert;
            window.alert = function(msg) {
                const str = String(msg);
                let type = 'info';
                if (/完美|成功|🎉|完成/.test(str)) type = 'success';
                else if (/失败|损坏|错误/.test(str)) type = 'error';
                else if (/为空|提示/.test(str)) type = 'warning';
                showToast(str, type, 4000);
            };
        })();

        // --- 2. 🌟 全局深度穿透搜索引擎 (Milanote 风格) ---
        (function initSearch() {
            const searchBar = document.getElementById('searchBar');
            const searchInput = document.getElementById('searchInput');
            const searchClose = document.getElementById('searchClose');
            const dropdown = document.getElementById('searchResultsDropdown');
            if (!searchBar || !searchInput || !dropdown) return;

            let debounceTimer = null;

            // 根据卡片类型返回对应的图标
            function getIconForType(type) {
                switch(type) {
                    case 'note': return 'fa-solid fa-bars';
                    case 'heading': return 'fa-solid fa-heading';
                    case 'todo': return 'fa-solid fa-list-check';
                    case 'board': return 'fa-solid fa-border-all';
                    case 'column': return 'fa-solid fa-columns';
                    case 'link': return 'fa-solid fa-link';
                    case 'image': return 'fa-regular fa-image';
                    case 'file': return 'fa-regular fa-file';
                    default: return 'fa-regular fa-note-sticky';
                }
            }

            // 获取卡片的纯文本内容用于搜索
            function getCardText(card) {
                const type = card.dataset.type;
                if (type === 'heading') return card.querySelector('.heading-text')?.innerText || '';
                if (type === 'note') return card.querySelector('.md-editor')?.innerText || '';
                if (type === 'todo') return Array.from(card.querySelectorAll('.todo-text')).map(t => t.innerText).join(' ');
                if (type === 'board') return card.querySelector('.board-title')?.innerText || '';
                if (type === 'column') return card.querySelector('.column-title')?.innerText || '';
                if (type === 'table') return card.querySelector('.table-wrap')?.innerText || '';
                if (type === 'file') return card.dataset.filename || '';
                if (type === 'link') return getLinkCardText(card);
                return '';
            }

            // 逆推物理目录路径 (Root > Board A > Board B)
            function getBoardPathName(boardId) {
                if (!boardId || boardId === ROOT_BOARD_ID) return '根白板';
                const path = [];
                let curr = boardId;
                while (curr && curr !== ROOT_BOARD_ID) {
                    const el = document.getElementById(curr);
                    if (el && el.querySelector('.board-title')) {
                        path.unshift(el.querySelector('.board-title').innerText);
                        curr = el.dataset.boardId;
                    } else { break; }
                }
                path.unshift('根白板');
                return path.join(' / ');
            }

            // 执行搜索并渲染下拉面板
            function doSearch() {
                const rawQuery = searchInput.value.trim();
                const q = rawQuery.toLowerCase();
                document.querySelectorAll('.card.search-highlight').forEach(c => c.classList.remove('search-highlight'));
                dropdown.innerHTML = '';

                if (!q) {
                    // 🌟 核心突破：空状态时化身“画板大纲”，无视物理大小，列出所有元素！
                    dropdown.innerHTML = '<div style="padding: 10px 16px; font-size: 12px; font-weight: bold; color: #a0aab8; background: #f8f9fa; border-bottom: 1px solid rgba(0,0,0,0.03);">当前画板大纲 (点击直达)</div>';
                    const currentCards = allCards.filter(c => c.dataset.boardId === getActiveBoard());
                    if (currentCards.length === 0) {
                        dropdown.innerHTML += '<div class="search-empty">当前画板为空</div>';
                    } else {
                        currentCards.forEach(card => {
                            let title = getCardText(card).split('\n')[0].substring(0, 40) || '未命名内容';
                            const item = document.createElement('div');
                            item.className = 'search-result-item';
                            item.innerHTML = `
                                <div class="search-result-icon"><i class="${getIconForType(card.dataset.type)}"></i></div>
                                <div class="search-result-content" style="justify-content: center;">
                                    <div class="search-result-title">${title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
                                </div>
                            `;
                            item.addEventListener('click', () => jumpToCard(card));
                            dropdown.appendChild(item);
                        });
                    }
                    dropdown.classList.add('show');
                    return;
                }

                const allCards = Array.from(canvas.querySelectorAll('.card'));
                const matches = [];

                allCards.forEach(card => {
                    const rawText = getCardText(card);
                    if (!rawText) return;

                    const lowerText = rawText.toLowerCase();
                    const idx = lowerText.indexOf(q);

                    if (idx !== -1) {
                        // 智能截取高亮片段
                        const start = Math.max(0, idx - 15);
                        const end = Math.min(rawText.length, idx + q.length + 20);
                        let snippet = rawText.substring(start, end);

                        const regex = new RegExp(`(${rawQuery.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})`, 'gi');
                        snippet = snippet.replace(regex, '<mark>$1</mark>');
                        if (start > 0) snippet = '...' + snippet;
                        if (end < rawText.length) snippet = snippet + '...';

                        // 提取第一行作为 Title
                        let title = rawText.split('\\n')[0].substring(0, 30);
                        title = title.replace(regex, '<mark>$1</mark>');

                        matches.push({ card, title, snippet, path: getBoardPathName(card.dataset.boardId), type: card.dataset.type });
                    }
                });

                if (matches.length > 0) {
                    matches.forEach(match => {
                        const item = document.createElement('div');
                        item.className = 'search-result-item';
                        item.innerHTML = `
                            <div class="search-result-icon"><i class="${getIconForType(match.type)}"></i></div>
                            <div class="search-result-content">
                                <div class="search-result-title">${match.title || '无标题内容'}</div>
                                <div class="search-result-snippet">${match.snippet}</div>
                                <div class="search-result-path"><i class="fa-solid fa-folder-tree"></i> ${escapeHtml(match.path)}</div>
                            </div>
                        `;
                        // 🌟 核心突破：点击即可跨层级跳转
                        item.addEventListener('click', () => jumpToCard(match.card));
                        dropdown.appendChild(item);
                    });
                } else {
                    dropdown.innerHTML = `<div class="search-empty">没有找到与 "${escapeHtml(rawQuery)}" 相关的内容</div>`;
                }
                dropdown.classList.add('show');
            }

            // 🌟 跨越目录层级上帝视角空降
            function jumpToCard(card) {
                const targetBoardId = card.dataset.boardId || ROOT_BOARD_ID;

                // 1. 如果在深层画板中，暴力重写宇宙时间线并切入目标画板
                if (targetBoardId !== getActiveBoard()) {
                    const newPath = [];
                    let curr = targetBoardId;
                    while (curr && curr !== ROOT_BOARD_ID) {
                        newPath.unshift(curr);
                        const el = document.getElementById(curr);
                        if (el) curr = el.dataset.boardId;
                        else break;
                    }
                    newPath.unshift(ROOT_BOARD_ID);
                    boardStack = newPath; // 重写全局路径栈

                    if(typeof updateBreadcrumbs === 'function') updateBreadcrumbs();
                    refreshBoardVisibility();

                    // 顺便刷新左侧目录树状态
                    const treeDrawer = document.getElementById('treeDrawer');
                    const treePopover = document.getElementById('treePopover');
                    if ((treeDrawer && treeDrawer.classList.contains('open')) || (treePopover && treePopover.classList.contains('show'))) {
                        if(typeof renderBoardTree === 'function') renderBoardTree();
                    }
                }

                // 2. 镜头平滑居中，并打上高亮呼吸灯
                dropdown.classList.remove('show');
                searchBar.classList.remove('show'); // 搜完自动收起搜索栏，体验更清爽

                requestAnimationFrame(() => {
                    clearCardSelection();
                    card.classList.add('selected');
                    card.classList.add('search-highlight');
                    setTimeout(() => card.classList.remove('search-highlight'), 3000); // 3秒后自动熄灭呼吸灯

                    // 使用卡片的绝对坐标进行反向视野补偿
                    const cx = parseFloat(card.style.left) || 0;
                    const cy = parseFloat(card.style.top) || 0;
                    const w = parseFloat(card.style.width) || card.offsetWidth || 150;
                    const h = parseFloat(card.style.height) || card.offsetHeight || 100;

                    const vpRect = viewport.getBoundingClientRect();
                    panX = vpRect.width / 2 - (cx + w / 2) * scale;
                    panY = vpRect.height / 2 - (cy + h / 2) * scale;

                    if (typeof applyTransform === 'function') applyTransform();
                });
            }

            function openSearch() {
                searchBar.classList.add('show');
                searchInput.focus();
                searchInput.select();
                if (searchInput.value.trim()) doSearch();
            }

            function closeSearch() {
                searchBar.classList.remove('show');
                dropdown.classList.remove('show');
                searchInput.value = '';
                document.querySelectorAll('.card.search-highlight').forEach(c => c.classList.remove('search-highlight'));
            }

            // 监听输入，带防抖
            searchInput.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(doSearch, 200);
            });

            searchClose.addEventListener('click', closeSearch);

            // 监听全局 Ctrl+F
            document.addEventListener('keydown', (e) => {
                const isEditing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                    if (isEditing && !e.target.closest('#searchBar')) return;
                    e.preventDefault();
                    if (searchBar.classList.contains('show')) {
                        searchInput.focus();
                        searchInput.select();
                    } else {
                        openSearch();
                    }
                }
                if (e.key === 'Escape' && searchBar.classList.contains('show')) {
                    closeSearch();
                }
            });
        })();


        // --- 4. 设置菜单下拉交互与 JSON 原生备份导出/导入 ---
        (function initSettingsMenu() {
            const settingsBtn = document.getElementById('settingsBtn');
            const settingsPopover = document.getElementById('settingsPopover');
            if (settingsBtn && settingsPopover) {
                settingsBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 关闭其他所有面板
                    document.querySelectorAll('.popover-menu, .trash-popover, .context-menu').forEach(p => p.classList.remove('show'));
                    settingsPopover.classList.toggle('show');
                });
                settingsPopover.addEventListener('click', e => e.stopPropagation());
            }

            const exportJsonMenuBtn = document.getElementById('exportJsonMenuBtn');
            if (exportJsonMenuBtn) {
                exportJsonMenuBtn.addEventListener('click', () => {
                    settingsPopover.classList.remove('show');
                    if (typeof saveWorkspaceState === 'function') saveWorkspaceState();
                    const state = localStorage.getItem(STORAGE_KEY);
                    if (!state) { showToast('白板为空', 'warning'); return; }
                    const blob = new Blob([state], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
                    a.href = url; a.download = `whiteboard-backup-${ts}.json`;
                    document.body.appendChild(a); a.click(); a.remove();
                    URL.revokeObjectURL(url);
                    showToast('原生备份已下载', 'success');
                });
            }

            const importJsonMenuBtn = document.getElementById('importJsonMenuBtn');
            const jsonFileInput = document.getElementById('jsonFileInput');
            if (importJsonMenuBtn && jsonFileInput) {
                importJsonMenuBtn.addEventListener('click', () => {
                    settingsPopover.classList.remove('show');
                    jsonFileInput.click();
                });
                jsonFileInput.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        try {
                            const state = JSON.parse(ev.target.result);
                            if (!state || !Array.isArray(state.cards)) throw new Error('格式错误');
                            localStorage.setItem(STORAGE_KEY, ev.target.result);
                            if (typeof restoreWorkspaceState === 'function') restoreWorkspaceState();
                            showToast('备份已无损恢复', 'success');
                        } catch (err) {
                            showToast('备份文件损坏或格式错误', 'error');
                        }
                    };
                    reader.readAsText(file);
                    e.target.value = '';
                });
            }
        })();

        // --- 4.1 云端同步码：Supabase 快照同步 ---
        (function initWorkspaceSync() {
            const SYNC_META_KEY = 'noteboard-sync-meta-v1';
            const SYNC_UPLOAD_DELAY = 1200;
            const SYNC_POLL_INTERVAL = 30000;
            const config = window.NOTEBOARD_SYNC_CONFIG || {};
            const configured = !!(
                window.supabase
                && config.supabaseUrl
                && config.supabaseAnonKey
                && !/^YOUR_/i.test(config.supabaseUrl)
                && !/^YOUR_/i.test(config.supabaseAnonKey)
            );
            let syncClient = null;
            let uploadTimer = null;
            let isApplyingRemote = false;
            let isUploading = false;
            let hasPendingUpload = false;
            let suppressQueueUpload = false;

            const els = {
                menuBtn: document.getElementById('syncMenuBtn'),
                overlay: document.getElementById('syncPanelOverlay'),
                closeBtn: document.getElementById('syncPanelClose'),
                statusPill: document.getElementById('syncStatusPill'),
                configStatus: document.getElementById('syncConfigStatus'),
                currentCode: document.getElementById('syncCurrentCode'),
                input: document.getElementById('syncCodeInput'),
                createBtn: document.getElementById('syncCreateBtn'),
                joinBtn: document.getElementById('syncJoinBtn'),
                pullBtn: document.getElementById('syncPullBtn'),
                pushBtn: document.getElementById('syncPushBtn'),
                copyBtn: document.getElementById('syncCopyBtn'),
                disconnectBtn: document.getElementById('syncDisconnectBtn'),
                hint: document.getElementById('syncHint')
            };

            function getClient() {
                if (!configured) return null;
                if (!syncClient) syncClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
                return syncClient;
            }

            function getMeta() {
                try {
                    return JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}') || {};
                } catch {
                    return {};
                }
            }

            function setMeta(nextMeta) {
                const meta = { ...getMeta(), ...nextMeta };
                if (!meta.syncCode) {
                    localStorage.removeItem(SYNC_META_KEY);
                } else {
                    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
                }
                updateSyncUi();
                return meta;
            }

            function normalizeSyncCode(value) {
                return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
            }

            function generateSyncCode() {
                const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                const bytes = new Uint8Array(12);
                crypto.getRandomValues(bytes);
                let out = 'NB';
                for (let i = 0; i < bytes.length; i++) {
                    if (i % 4 === 0) out += '-';
                    out += alphabet[bytes[i] % alphabet.length];
                }
                return out;
            }

            function getCurrentPayload() {
                if (typeof saveWorkspaceState === 'function') {
                    suppressQueueUpload = true;
                    try {
                        saveWorkspaceState(true);
                    } finally {
                        suppressQueueUpload = false;
                    }
                }
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return { version: 1, boardStack: [ROOT_BOARD_ID], cards: [], lines: [], drawData: '' };
                return JSON.parse(raw);
            }

            function firstRpcRow(data) {
                return Array.isArray(data) ? data[0] : data;
            }

            function setBusy(busy) {
                [els.createBtn, els.joinBtn, els.pullBtn, els.pushBtn, els.disconnectBtn].forEach(btn => {
                    if (btn) btn.disabled = !!busy;
                });
            }

            function setStatus(text, type = 'info') {
                if (els.statusPill) {
                    const icons = { success: 'circle-check', error: 'circle-exclamation', warning: 'triangle-exclamation', info: 'circle-info' };
                    els.statusPill.innerHTML = `<i class="fa-solid fa-${icons[type] || icons.info}"></i> ${escapeHtml(text)}`;
                }
            }

            function updateSyncUi() {
                const meta = getMeta();
                if (els.configStatus) {
                    els.configStatus.textContent = configured ? 'Supabase 已配置' : '未配置 Supabase';
                }
                if (els.currentCode) {
                    els.currentCode.textContent = meta.syncCode || '暂无同步码';
                }
                if (els.input && meta.syncCode && !els.input.value) {
                    els.input.value = meta.syncCode;
                }
                if (els.copyBtn) els.copyBtn.disabled = !meta.syncCode;
                if (els.pullBtn) els.pullBtn.disabled = !configured || !meta.syncCode;
                if (els.pushBtn) els.pushBtn.disabled = !configured || !meta.syncCode;
                if (els.disconnectBtn) els.disconnectBtn.disabled = !meta.syncCode;
                if (!configured) {
                    setStatus('未配置', 'warning');
                    if (els.hint) els.hint.textContent = '请先在 sync-config.js 填入 Supabase URL 和 anon key，然后运行 supabase/schema.sql。';
                } else if (meta.syncCode) {
                    setStatus(hasPendingUpload ? '等待上传' : '已连接', hasPendingUpload ? 'warning' : 'success');
                    if (els.hint) els.hint.textContent = `同步码 ${meta.syncCode} 已连接。手机打开网页后输入这个同步码即可同步。`;
                } else {
                    setStatus('未连接', 'info');
                    if (els.hint) els.hint.textContent = '手机打开 GitHub Pages 网页版后输入同一个同步码，即可拉取这块白板。同步码相当于访问密码，请不要发给不信任的人。';
                }
            }

            async function createSyncSpace() {
                const client = getClient();
                if (!client) {
                    showToast('请先配置 Supabase', 'warning');
                    return;
                }
                setBusy(true);
                try {
                    const syncCode = generateSyncCode();
                    const payload = getCurrentPayload();
                    const { data, error } = await client.rpc('noteboard_create_space', {
                        p_sync_code: syncCode,
                        p_payload: payload
                    });
                    if (error) throw error;
                    const row = firstRpcRow(data) || {};
                    setMeta({
                        syncCode: row.sync_code || syncCode,
                        revision: Number(row.revision || 0),
                        updatedAt: row.updated_at || new Date().toISOString(),
                        enabled: true
                    });
                    hasPendingUpload = false;
                    showToast('同步码已创建', 'success');
                } catch (err) {
                    console.warn('[Sync] create failed', err);
                    showToast(`创建同步码失败：${err.message || '未知错误'}`, 'error');
                } finally {
                    setBusy(false);
                    updateSyncUi();
                }
            }

            async function joinSyncSpace() {
                const client = getClient();
                if (!client) {
                    showToast('请先配置 Supabase', 'warning');
                    return;
                }
                const syncCode = normalizeSyncCode(els.input?.value);
                if (!syncCode) {
                    showToast('请输入同步码', 'warning');
                    return;
                }
                const ok = confirm('加入同步码会用云端白板覆盖当前本地白板，继续吗？');
                if (!ok) return;
                setMeta({ syncCode, enabled: true, revision: null });
                await pullRemote({ quiet: false });
            }

            async function pullRemote({ quiet = false } = {}) {
                const client = getClient();
                const meta = getMeta();
                if (!client || !meta.syncCode) return;
                setBusy(true);
                try {
                    const { data, error } = await client.rpc('noteboard_pull', { p_sync_code: meta.syncCode });
                    if (error) throw error;
                    const row = firstRpcRow(data);
                    if (!row || !row.payload) throw new Error('同步码不存在或云端没有数据');
                    const raw = JSON.stringify(row.payload);
                    isApplyingRemote = true;
                    localStorage.setItem(STORAGE_KEY, raw);
                    currentStateStr = raw;
                    if (typeof restoreWorkspaceState === 'function') restoreWorkspaceState();
                    setTimeout(() => { isApplyingRemote = false; }, 500);
                    hasPendingUpload = false;
                    setMeta({
                        revision: Number(row.revision || 0),
                        updatedAt: row.updated_at || new Date().toISOString(),
                        enabled: true
                    });
                    if (!quiet) showToast('已拉取云端白板', 'success');
                } catch (err) {
                    console.warn('[Sync] pull failed', err);
                    if (!quiet) showToast(`拉取失败：${err.message || '未知错误'}`, 'error');
                } finally {
                    setBusy(false);
                    updateSyncUi();
                }
            }

            async function pushRemote({ force = false, quiet = false } = {}) {
                const client = getClient();
                const meta = getMeta();
                if (!client || !meta.syncCode || isUploading) return;
                isUploading = true;
                setBusy(true);
                try {
                    const payload = getCurrentPayload();
                    const { data, error } = await client.rpc('noteboard_push', {
                        p_sync_code: meta.syncCode,
                        p_payload: payload,
                        p_base_revision: force ? null : (Number.isFinite(Number(meta.revision)) ? Number(meta.revision) : null)
                    });
                    if (error) throw error;
                    const row = firstRpcRow(data);
                    if (row?.conflict) {
                        hasPendingUpload = true;
                        setMeta({
                            revision: Number(row.revision || meta.revision || 0),
                            updatedAt: row.updated_at || meta.updatedAt
                        });
                        if (!quiet) showToast('云端已有更新，请先拉取或点击“上传覆盖”', 'warning');
                        return;
                    }
                    hasPendingUpload = false;
                    setMeta({
                        revision: Number(row?.revision || 0),
                        updatedAt: row?.updated_at || new Date().toISOString(),
                        enabled: true
                    });
                    if (!quiet) showToast('已上传到云端', 'success');
                } catch (err) {
                    hasPendingUpload = true;
                    console.warn('[Sync] push failed', err);
                    if (!quiet) showToast(`上传失败：${err.message || '未知错误'}`, 'error');
                } finally {
                    isUploading = false;
                    setBusy(false);
                    updateSyncUi();
                }
            }

            function queueUpload() {
                const meta = getMeta();
                if (suppressQueueUpload || isApplyingRemote || !configured || !meta.syncCode) return;
                hasPendingUpload = true;
                updateSyncUi();
                clearTimeout(uploadTimer);
                uploadTimer = setTimeout(() => {
                    pushRemote({ quiet: true }).catch(err => console.warn('[Sync] auto push failed', err));
                }, SYNC_UPLOAD_DELAY);
            }

            async function pollRemote() {
                const client = getClient();
                const meta = getMeta();
                if (!client || !meta.syncCode || document.hidden || hasPendingUpload || isUploading) return;
                try {
                    const { data, error } = await client.rpc('noteboard_pull', { p_sync_code: meta.syncCode });
                    if (error) throw error;
                    const row = firstRpcRow(data);
                    const remoteRevision = Number(row?.revision || 0);
                    if (remoteRevision > Number(meta.revision || 0)) {
                        await pullRemote({ quiet: true });
                        showToast('已同步手机上的新内容', 'info', 1800);
                    }
                } catch (err) {
                    console.warn('[Sync] poll failed', err);
                }
            }

            function disconnectSync() {
                localStorage.removeItem(SYNC_META_KEY);
                hasPendingUpload = false;
                clearTimeout(uploadTimer);
                updateSyncUi();
                showToast('已断开同步码，本地数据仍保留', 'info');
            }

            if (els.menuBtn && els.overlay) {
                els.menuBtn.addEventListener('click', () => {
                    const settingsPopover = document.getElementById('settingsPopover');
                    if (settingsPopover) settingsPopover.classList.remove('show');
                    updateSyncUi();
                    els.overlay.classList.add('show');
                });
            }
            if (els.overlay) {
                els.overlay.addEventListener('click', (e) => {
                    if (e.target === els.overlay) els.overlay.classList.remove('show');
                });
            }
            if (els.closeBtn) els.closeBtn.addEventListener('click', () => els.overlay?.classList.remove('show'));
            if (els.createBtn) els.createBtn.addEventListener('click', createSyncSpace);
            if (els.joinBtn) els.joinBtn.addEventListener('click', joinSyncSpace);
            if (els.pullBtn) els.pullBtn.addEventListener('click', () => pullRemote({ quiet: false }));
            if (els.pushBtn) els.pushBtn.addEventListener('click', () => pushRemote({ force: true, quiet: false }));
            if (els.disconnectBtn) els.disconnectBtn.addEventListener('click', disconnectSync);
            if (els.copyBtn) {
                els.copyBtn.addEventListener('click', async () => {
                    const code = getMeta().syncCode || '';
                    if (!code) return;
                    await navigator.clipboard.writeText(code).catch(() => {});
                    showToast('同步码已复制', 'success', 1600);
                });
            }
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && els.overlay?.classList.contains('show')) {
                    els.overlay.classList.remove('show');
                }
            });

            setInterval(pollRemote, SYNC_POLL_INTERVAL);
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) pollRemote();
            });

            window.noteboardSync = { queueUpload, pullRemote, pushRemote, updateSyncUi };
            updateSyncUi();
        })();

            const accountMenuBtn = document.getElementById('accountMenuBtn');
            const accountPanelOverlay = document.getElementById('accountPanelOverlay');
            const accountPanelClose = document.getElementById('accountPanelClose');

            // --- Cookie helpers ---
            function getCookie(site) {
                return localStorage.getItem(`${site}_cookie`) || '';
            }
            function setCookie(site, value) {
                localStorage.setItem(`${site}_cookie`, value.trim());
            }
            function clearCookie(site) {
                localStorage.removeItem(`${site}_cookie`);
            }
            function syncSiteCookies(site, cookieHeader) {
                try {
                    const { ipcRenderer } = require('electron');
                    return ipcRenderer.invoke('set-site-cookies', site, cookieHeader).catch(() => 0);
                } catch {
                    return Promise.resolve(0);
                }
            }
            function clearSiteCookies(site) {
                try {
                    const { ipcRenderer } = require('electron');
                    return ipcRenderer.invoke('clear-site-cookies', site).catch(() => 0);
                } catch {
                    return Promise.resolve(0);
                }
            }
            function reloadBilibiliPlayers() {
                document.querySelectorAll('.link-card iframe.embedded-video-frame').forEach(frame => {
                    if (!/bilibili\.com/i.test(frame.src || '')) return;
                    try {
                        const url = new URL(frame.src);
                        url.searchParams.set('_noteboard_auth', String(Date.now()));
                        frame.src = url.href;
                    } catch {
                        frame.src = frame.src;
                    }
                });
            }
            function updateLoginStatus(site, loggedIn) {
                const prefix = site === 'bilibili' ? 'bili' : 'yt';
                const el = document.getElementById(`${prefix}LoginStatus`);
                if (el) {
                    el.innerHTML = loggedIn
                        ? '<span style="color:#10b981;"><i class="fa-solid fa-circle-check"></i> 已登录</span>'
                        : '';
                }
                const inputEl = document.getElementById(`${site}CookieInput`);
                if (inputEl && !inputEl.value) {
                    inputEl.value = loggedIn ? getCookie(site) : '';
                }
            }
            function refreshAllStatus() {
                ['bilibili', 'youtube'].forEach(site => {
                    const cookieValue = getCookie(site);
                    updateLoginStatus(site, !!cookieValue);
                    if (site === 'bilibili' && cookieValue) syncSiteCookies(site, cookieValue);
                });
            }

            // --- Panel open/close ---
            if (accountMenuBtn && accountPanelOverlay) {
                accountMenuBtn.addEventListener('click', () => {
                    document.getElementById('settingsPopover').classList.remove('show');
                    refreshAllStatus();
                    accountPanelOverlay.classList.add('show');
                });
            }
            if (accountPanelOverlay) {
                accountPanelOverlay.addEventListener('click', (e) => {
                    if (e.target === accountPanelOverlay) accountPanelOverlay.classList.remove('show');
                });
                if (accountPanelClose) {
                    accountPanelClose.addEventListener('click', () => accountPanelOverlay.classList.remove('show'));
                }
            }

            // --- Tab switching ---
            document.querySelectorAll('.account-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.account-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    document.querySelectorAll('.account-tab-content').forEach(c => c.classList.remove('active'));
                    const target = document.getElementById(tab.dataset.tab === 'bilibili' ? 'tabBilibili' : 'tabYoutube');
                    if (target) target.classList.add('active');
                });
            });

            // --- Fallback toggle ---
            ['bilibili', 'youtube'].forEach(site => {
                const prefix = site === 'bilibili' ? 'bili' : 'yt';
                const toggle = document.getElementById(`${prefix}FallbackToggle`);
                const content = document.getElementById(`${prefix}FallbackContent`);
                if (toggle && content) {
                    toggle.addEventListener('click', () => {
                        const open = content.style.display !== 'none';
                        content.style.display = open ? 'none' : 'flex';
                        const icon = toggle.querySelector('i');
                        if (icon) icon.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
                    });
                }
            });

            // --- Manual cookie save/clear ---
            ['bilibili', 'youtube'].forEach(site => {
                const saveBtn = document.getElementById(`${site}SaveBtn`);
                const clearBtn = document.getElementById(`${site}ClearBtn`);
                const inputEl = document.getElementById(`${site}CookieInput`);
                if (saveBtn && inputEl) {
                    saveBtn.addEventListener('click', async () => {
                        const cookieValue = inputEl.value.trim();
                        setCookie(site, cookieValue);
                        await syncSiteCookies(site, cookieValue);
                        updateLoginStatus(site, !!cookieValue);
                        if (site === 'bilibili') reloadBilibiliPlayers();
                        if (typeof showToast === 'function') {
                            const name = site === 'bilibili' ? 'B站' : 'YouTube';
                            showToast(`✅ ${name} Cookie 已保存`, 'success');
                        }
                    });
                }
                if (clearBtn) {
                    clearBtn.addEventListener('click', async () => {
                        clearCookie(site);
                        await clearSiteCookies(site);
                        if (inputEl) inputEl.value = '';
                        updateLoginStatus(site, false);
                        if (typeof showToast === 'function') {
                            const name = site === 'bilibili' ? 'B站' : 'YouTube';
                            showToast(`${name} Cookie 已清除`, 'info');
                        }
                    });
                }
            });

            // ======= B站登录（打开登录窗口） =======
            const biliLoginBtn = document.getElementById('biliLoginBtn');
            if (biliLoginBtn) {
                biliLoginBtn.addEventListener('click', async () => {
                    const statusEl = document.getElementById('biliLoginStatus');
                    if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary-blue);"><i class="fa-solid fa-spinner fa-spin"></i> 正在打开 B站 登录页...</span>';
                    biliLoginBtn.disabled = true;

                    try {
                        const { ipcRenderer } = require('electron');
                        const cookies = await ipcRenderer.invoke('bilibili-login');
                        if (cookies && cookies.length > 0) {
                            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            setCookie('bilibili', cookieStr);
                            await syncSiteCookies('bilibili', cookieStr);
                            updateLoginStatus('bilibili', true);
                            reloadBilibiliPlayers();
                            if (typeof showToast === 'function') showToast('✅ B站 登录成功！', 'success');
                        } else {
                            updateLoginStatus('bilibili', false);
                            if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;">未检测到登录，请重试</span>';
                        }
                    } catch (err) {
                        console.warn('[BiliLogin]', err);
                        if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">登录失败: ${err.message || '未知错误'}</span>`;
                    }
                    biliLoginBtn.disabled = false;
                });
            }

            // ======= YouTube 登录（打开登录窗口） =======
            const ytLoginBtn = document.getElementById('ytLoginBtn');
            if (ytLoginBtn) {
                ytLoginBtn.addEventListener('click', async () => {
                    const statusEl = document.getElementById('ytLoginStatus');
                    if (statusEl) statusEl.innerHTML = '<span style="color:var(--primary-blue);"><i class="fa-solid fa-spinner fa-spin"></i> 正在打开 YouTube 登录页...</span>';
                    ytLoginBtn.disabled = true;

                    try {
                        const { ipcRenderer } = require('electron');
                        const result = await ipcRenderer.invoke('youtube-login');
                        if (result && result.external) {
                            const fallback = document.getElementById('ytFallbackContent');
                            if (fallback) fallback.style.display = 'flex';
                            const toggleIcon = document.querySelector('#ytFallbackToggle i');
                            if (toggleIcon) toggleIcon.style.transform = 'rotate(180deg)';
                            updateLoginStatus('youtube', !!getCookie('youtube'));
                            if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;">Google 会拦截内置登录，已改用系统浏览器；如需登录态，请手动粘贴 Cookie 后保存</span>';
                            ytLoginBtn.disabled = false;
                            return;
                        }
                        const cookies = Array.isArray(result) ? result : [];
                        if (cookies && cookies.length > 0) {
                            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            setCookie('youtube', cookieStr);
                            await syncSiteCookies('youtube', cookieStr);
                            updateLoginStatus('youtube', true);
                            if (typeof showToast === 'function') showToast('✅ YouTube 登录成功！', 'success');
                        } else {
                            updateLoginStatus('youtube', false);
                            if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;">未检测到登录，请重试</span>';
                        }
                    } catch (err) {
                        console.warn('[YTLogin]', err);
                        if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">登录失败: ${err.message || '未知错误'}</span>`;
                    }
                    ytLoginBtn.disabled = false;
                });
            }

            refreshAllStatus();

            // --- Esc 关闭 ---
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && accountPanelOverlay && accountPanelOverlay.classList.contains('show')) {
                    accountPanelOverlay.classList.remove('show');
                }
            });

        // --- 5. 安全的表格公式计算：替换危险的 eval() ---
        if (typeof computeTable === 'function') {
            window.computeTable = function(table) {
                const data = {}; let r = 1;
                table.querySelectorAll('tr').forEach((row) => {
                    let c = 0;
                    row.querySelectorAll('td, th').forEach(cell => {
                        const name = String.fromCharCode(65 + c) + r;
                        data[name] = parseFloat(cell.innerText) || 0;
                        cell.dataset.name = name;
                        c++;
                    });
                    r++;
                });
                table.querySelectorAll('td, th').forEach(cell => {
                    if (cell.dataset.formula) {
                        try {
                            let expr = cell.dataset.formula.substring(1).toUpperCase().replace(/[A-Z]\d/g, m => data[m] || 0);
                            // 只允许数字、运算符、括号、小数点、空格，禁止任何字母/标识符避免 XSS
                            if (!/^[\d+\-*/().\s]+$/.test(expr)) { cell.innerText = "ERR"; return; }
                            // 使用 Function 构造器而非 eval，隔离作用域
                            const result = new Function('return (' + expr + ')')();
                            cell.innerText = Number.isFinite(result) ? result : 'ERR';
                        } catch(err) { cell.innerText = "ERR"; }
                    }
                });
            };
        }

        // --- 6. 欢迎提示（仅首次打开显示） ---
        if (!localStorage.getItem('gemeni-seen-welcome')) {
            setTimeout(() => {
                showToast('快捷键：Ctrl+F 搜索 · Ctrl+A 全选 · Ctrl+D 复制 · Ctrl+Z 撤销', 'info', 6000);
                localStorage.setItem('gemeni-seen-welcome', '1');
            }, 800);
        }


        // ================= 核心新增：视口缩放与自适应视野 (Fit View) 引擎 =================
        const zoomOutBtn = document.getElementById('zoomOutBtn');
        const zoomInBtn = document.getElementById('zoomInBtn');
        const zoomPercentDisplay = document.getElementById('zoomPercentDisplay');
        const fitViewBtn = document.getElementById('fitViewBtn');

        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { scale = Math.max(0.05, scale / 1.25); applyTransform(); });
        if (zoomInBtn) zoomInBtn.addEventListener('click', () => { scale = Math.min(5, scale * 1.25); applyTransform(); });
        if (zoomPercentDisplay) zoomPercentDisplay.addEventListener('click', () => { scale = 1; applyTransform(); }); // 点击比例直达 100%

        // 终极武器：自动扫描物理空间，计算最完美的镜头位置并缩放统揽
        function fitView() {
            const cards = Array.from(document.querySelectorAll('.card')).filter(c => c.dataset.boardId === getActiveBoard() && c.style.display !== 'none');
            if (cards.length === 0) { scale = 1; panX = 0; panY = 0; applyTransform(); return; }

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            cards.forEach(c => {
                const x = parseFloat(c.style.left) || 0; const y = parseFloat(c.style.top) || 0;
                const w = c.offsetWidth || 150; const h = c.offsetHeight || 100;
                if (x < minX) minX = x; if (y < minY) minY = y;
                if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;
            });

            const pad = 80; const vpW = viewport.clientWidth; const vpH = viewport.clientHeight;
            const bboxW = maxX - minX; const bboxH = maxY - minY;

            let idealScale = Math.min((vpW - pad * 2) / bboxW, (vpH - pad * 2) / bboxH);
            idealScale = Math.max(0.05, Math.min(1.2, idealScale)); // 智能锁帧，不至于单张便签放大到瞎眼

            scale = idealScale;
            panX = vpW / 2 - (minX + bboxW / 2) * scale;
            panY = vpH / 2 - (minY + bboxH / 2) * scale;

            applyTransform();
            if (typeof updateMinimap === 'function') updateMinimap();
        }

// 绑定按钮点击 (已修复：移除重复的 const 声明与冗余逻辑)
        if (fitViewBtn) {
            fitViewBtn.addEventListener('click', () => {
                fitView();
                // 动效反馈：点击后按钮闪烁一下
                fitViewBtn.style.color = 'var(--primary-blue)';
                setTimeout(() => fitViewBtn.style.color = '', 300);
            });
        }

        // 注入 Shift + 1 行业标配快捷键
        document.addEventListener('keydown', (e) => {
            const isEditing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
            if (isEditing) return;
            if (e.key === '!' && e.shiftKey) { e.preventDefault(); fitView(); } // Shift + 1触发统揽
        });

                        // ================= 夜间模式核心逻辑 (设置菜单版) =================
        const themeToggleMenuBtn = document.getElementById('themeToggleMenuBtn');
        if (themeToggleMenuBtn) {
            const themeIcon = themeToggleMenuBtn.querySelector('i');
            const themeText = themeToggleMenuBtn.querySelector('span');

            function applyTheme(isDark) {
                if (isDark) {
                    document.body.classList.add('dark-mode');
                    if(themeIcon) themeIcon.className = 'fa-solid fa-sun';
                    if(themeText) themeText.innerText = '日间模式';
                } else {
                    document.body.classList.remove('dark-mode');
                    if(themeIcon) themeIcon.className = 'fa-solid fa-moon';
                    if(themeText) themeText.innerText = '夜间模式';
                }
            }

            themeToggleMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止点击事件冒泡冲突
                const isDark = document.body.classList.toggle('dark-mode');
                applyTheme(isDark);
                localStorage.setItem('theme-preference', isDark ? 'dark' : 'light');
                
                // 切换后自动隐藏右上角的下拉菜单
                const settingsPopover = document.getElementById('settingsPopover');
                if (settingsPopover) settingsPopover.classList.remove('show');
            });
        }

        // ================= 全局初始化加载 =================
        window.addEventListener('DOMContentLoaded', () => {
            renderLines();
            updateMinimap();
            if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
                navigator.serviceWorker.register('./sw.js').catch(err => console.warn('[PWA] service worker registration failed', err));
            }
            
            // 夜间模式初始化检测
            const savedTheme = localStorage.getItem('theme-preference');
            if (typeof applyTheme === 'function') {
                applyTheme(savedTheme === 'dark');
            }
        });
