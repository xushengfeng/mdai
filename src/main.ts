import { watchFile, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import YAML from "yaml";
import { fileTypeFromFile } from "file-type";
import { isBinaryFileSync } from "isbinaryfile";
import mammoth from "mammoth";
import * as xlsx from "xlsx";

let configPath = path.join(
    homedir(),
    process.platform === "win32" ? "AppData/Roaming" : ".config",
    "mdai",
    "config.json"
);
if (existsSync(configPath)) {
    var _config = JSON.parse(readFileSync(configPath).toString());
}
let fileName = process.argv[2];
if (!path.isAbsolute(fileName)) fileName = path.join(process.cwd(), process.argv[2]);
let canWatch = true;
if (!existsSync(fileName)) {
    writeFileSync(fileName, ":> ");
    console.log(`created ${fileName}`);
}
console.log(`watching ${fileName}`);

watchFile(fileName, async () => {
    if (!canWatch) return;
    let text = readFileSync(fileName).toString();
    let p = await parse(text);
    if (!p) return;
    canWatch = false;
    setText("?...");
    let aix = ai(p.ai, p.option.config);
    let answer = "";
    try {
        answer = await aix.text;
    } catch (error) {
        console.error(error);
        answer = error.toString();
    }
    answer = answer.replace(/(.|\n)*/, p.option.aiAnswer);
    setText(answer);
    function setText(answer: string) {
        let out = text.slice(0, p.option.index) + answer + text.slice(p.option.index + p.option.askMark.length);
        writeFileSync(fileName, out);
    }
    canWatch = true;
});

type aim = { role: "system" | "user" | "assistant"; content: { text: string; img?: { src: string; mime: string } } }[];
type chatgptm = {
    role: "system" | "user" | "assistant";
    content: string | [{ type: "text"; text: string }, { type: "image_url"; image_url: { url: string } }];
}[];
type geminim = {
    parts: [
        { text: string },
        {
            inline_data: {
                mime_type: string;
                data: string;
            };
        }?
    ];
    role: "user" | "model";
}[];
type aiconfig = { type: "chatgpt" | "gemini"; key?: string; url?: string; option?: Object };

function ai(m: aim, config: aiconfig) {
    let chatgpt = {
        url: config.url || `https://api.openai.com/v1/chat/completions`,
        headers: {
            "content-type": "application/json",
        },
        config: {
            model: "gpt-3.5-turbo",
        },
    };
    let gemini = {
        url: config.url || "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        headers: { "content-type": "application/json" },
        config: {},
    };
    let url = "";
    let headers = {};
    let con = {};
    if (config.type === "chatgpt") {
        url = chatgpt.url;
        headers = chatgpt.headers;
        if (config.key) headers["Authorization"] = `Bearer ${config.key}`;
        for (let i in config.option) {
            con[i] = config.option[i];
        }
        let messages: chatgptm = [];
        for (let i of m) {
            if (i.content.img) {
                const content: chatgptm[0]["content"] = [
                    { type: "text", text: i.content.text },
                    { type: "image_url", image_url: { url: i.content.img.src } },
                ];
                messages.push({ role: i.role, content: content });
            } else messages.push({ role: i.role, content: i.content.text });
        }
        con["messages"] = messages;
    }
    if (config.type === "gemini") {
        let newurl = new URL(gemini.url);
        if (config.key) newurl.searchParams.set("key", config.key);
        url = newurl.toString();
        for (let i in config.option) {
            con[i] = config.option[i];
        }
        let geminiPrompt: geminim = [];
        for (let i of m) {
            let role: (typeof geminiPrompt)[0]["role"];
            if (i.role === "system" || i.role === "user") role = "user";
            else role = "model";
            const parts: geminim[0]["parts"] = [{ text: i.content.text }];
            if (i.content.img) parts.push({ inline_data: { mime_type: i.content.img.mime, data: i.content.img.src } });
            geminiPrompt.push({ parts: parts, role });
        }
        con["contents"] = geminiPrompt;
    }

    let abort = new AbortController();
    return {
        stop: abort,
        text: new Promise(async (re: (text: string) => void, rj: (err: Error) => void) => {
            fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(con),
                signal: abort.signal,
            })
                .then((v) => {
                    return v.json();
                })
                .then((t) => {
                    let answer = `错误：${JSON.stringify(t)}`;
                    if (config.type === "chatgpt") {
                        try {
                            answer = t.message?.content || t.choices[0].message.content;
                        } catch (error) {}
                        re(answer);
                    } else {
                        try {
                            answer = t.candidates[0].content.parts[0].text;
                        } catch (error) {}
                        re(answer);
                    }
                })
                .catch((e) => {
                    if (e.name === "AbortError") {
                        return;
                    } else {
                        rj(e);
                    }
                });
        }),
    };
}

async function parse(text: string) {
    let l = text.split("\n");
    let index = 0;
    const opMark = "---";
    const newMark = "---";
    let ignoreMark = "//";
    let userMark = ":>";
    let aiMark = "!>";
    let askMark = "??";
    let aiAnswer = "\n!>\n$&";
    let shareSys = false;
    let isOp = false;
    let op: string[] = [];
    let aiM: aim = [];
    let aiConfig: aiconfig = _config || { type: "chatgpt" };
    l.push(newMark);
    let ps: { text: string; index: number }[] = l.map((i) => {
        let oi = index;
        index += i.length + 1;
        return { text: i, index: oi };
    });
    let dataStart = 0;
    for (let n = 0; n < l.length; n++) {
        const i = l[n];
        if (i === opMark) {
            if (n === 0) {
                isOp = true;
                continue;
            } else {
                if (isOp) {
                    dataStart = n + 1;

                    let option = YAML.parse(op.join("\n"));
                    console.log(option);
                    ignoreMark = option["ignore"] || ignoreMark;
                    userMark = option["user"] || userMark;
                    aiMark = option["ai"] || aiMark;
                    askMark = option["ask"] || askMark;
                    aiAnswer = option["answer"] || aiAnswer;
                    shareSys = Boolean(option["shareSys"]);
                    aiConfig = Object.assign(aiConfig, option["config"]);

                    break;
                }
            }
        }
        if (isOp) {
            op.push(i);
        }
    }
    if (aiMark.startsWith(userMark) || userMark.startsWith(aiMark)) {
        console.error(`user(${userMark}) <-> ai(${aiMark})`);
        return;
    }
    if (!aiAnswer.includes(aiMark)) {
        console.error(`ai(${aiMark}) !in answer(${aiAnswer})`);
    }
    let askIndex = 0;
    for (let n = dataStart; n < ps.length; n++) {
        const i = ps[n].text;
        if (i.startsWith(aiMark)) {
            aiM.push({ role: "assistant", content: { text: i.replace(aiMark, "") } });
        } else if (i.startsWith(userMark)) {
            aiM.push({ role: "user", content: { text: i.replace(userMark, "") } });
        } else if (i === askMark) {
            askIndex = ps[n].index;
            break;
        } else if (i.startsWith(ignoreMark)) {
            continue;
        } else if (i === newMark) {
            // ask 在 new 之前检测，换句话，若到了new无ask，则抛弃
            if (shareSys) {
                aiM = aiM.filter((i) => i.role === "system");
            } else {
                aiM = [];
            }
        } else {
            if (aiM.length) {
                const imageRegex = /!\[.*\]\((.*?)\)/g;
                const linkRegex = /\[.*\]\((.*?)\)/g;
                const imageMeach = imageRegex.exec(i);
                const linkMeach = linkRegex.exec(i);
                if (imageMeach) {
                    let img = await parseImageUrl(imageMeach[1]);
                    aiM.at(-1).content["img"] = img;
                } else if (linkMeach) {
                    aiM.at(-1).content.text += await parseUrl(linkMeach[1]);
                } else {
                    aiM.at(-1).content.text += "\n" + i;
                }
            } else {
                aiM.push({ role: "system", content: { text: i } });
            }
        }
    }
    aiM.forEach((i) => i.content.text.trim());
    aiM = aiM.filter((i) => i.content);
    if (aiM.length === 0) return;
    if (!aiConfig.type) aiConfig.type = "chatgpt";
    return { ai: aiM, option: { index: askIndex, askMark, aiAnswer, config: aiConfig } };
}

async function parseImageUrl(url: string) {
    if (url.startsWith("http://") || url.startsWith("https://")) {
        return { src: url, mime: "" };
    } else {
        let imgpath = url;
        if (!path.isAbsolute(imgpath)) {
            imgpath = path.join(fileName, "..", imgpath);
        }
        let img = readFileSync(imgpath);
        let base64 = img.toString("base64");
        let mime = await fileTypeFromFile(imgpath);
        return { src: base64, mime: mime.mime };
    }
}

async function parseUrl(url: string) {
    let filePath = "";
    if (url.startsWith("http://") || url.startsWith("https://")) {
        fetch(url)
            .then((v) => v.arrayBuffer())
            .then((v) => {
                filePath = path.join(fileName, "..", new Date().getTime().toString());
                writeFileSync(filePath, Buffer.from(v));
            });
    } else {
        filePath = url;
        if (!path.isAbsolute(filePath)) {
            filePath = path.join(fileName, "..", filePath);
        }
    }
    console.log(filePath);

    const isB = isBinaryFileSync(filePath);
    console.log(isB);

    if (!isB) return readFileSync(filePath).toString();

    let mime = await fileTypeFromFile(filePath);
    if (!mime) return url;

    if (mime.mime === "application/pdf") {
    } else if (mime.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        let dataBuffer = readFileSync(filePath, "binary");
        return (await mammoth.extractRawText({ buffer: Buffer.from(dataBuffer) })).value;
    } else if (mime.mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
        const workbook = xlsx.readFile(filePath);
        const sheetNames = workbook.SheetNames;
        let textL: string[] = [];
        for (let i of sheetNames) {
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetNames[0]]);
            textL.push(i, JSON.stringify(data));
        }
        return textL.join("\n");
    } else return url;
}
