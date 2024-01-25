import { watchFile, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import YAML from "yaml";

let configPath = path.join(homedir(), process.platform === "win32" ? "AppData" : ".config", "mdai", "config.json");
if (existsSync(configPath)) {
    var _config = JSON.parse(readFileSync(configPath).toString());
}

const fileName = path.join(process.cwd(), process.argv[2]);
let canWatch = true;
if (!existsSync(fileName)) {
    writeFileSync(fileName, "");
    console.log(`created ${fileName}`);
}
console.log(`watching ${fileName}`);

watchFile(fileName, async () => {
    if (!canWatch) return;
    let text = readFileSync(fileName).toString();
    let p = parse(text);
    if (!p) return;
    let aix = ai(p.ai, p.option.config);
    canWatch = false;
    let answer = "";
    try {
        answer = await aix.text;
    } catch (error) {
        console.error(error);
        answer = error.toString();
    }
    answer = answer.replace(/(.|\n)*/, p.option.aiAnswer);
    let out = text.slice(0, p.option.index) + answer + text.slice(p.option.index + p.option.askMark.length);
    writeFileSync(fileName, out);
    canWatch = true;
});

type aim = { role: "system" | "user" | "assistant"; content: string }[];
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
        con["messages"] = m;
    }
    if (config.type === "gemini") {
        let newurl = new URL(gemini.url);
        if (config.key) newurl.searchParams.set("key", config.key);
        url = newurl.toString();
        for (let i in config.option) {
            con[i] = config.option[i];
        }
        let geminiPrompt: { parts: [{ text: string }]; role: "user" | "model" }[] = [];
        for (let i of m) {
            let role: (typeof geminiPrompt)[0]["role"];
            if (i.role === "system" || i.role === "user") role = "user";
            else role = "model";
            geminiPrompt.push({ parts: [{ text: i.content }], role });
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
                    if (config.type === "chatgpt") {
                        let answer = t.choices[0].message.content;
                        console.log(answer);
                        re(answer);
                    } else {
                        let answer = t.candidates[0].content.parts[0].text;
                        console.log(answer);
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

function parse(text: string) {
    let l = text.split("\n");
    let index = 0;
    const opMark = "---";
    const newMark = "---";
    let ignoreMark = "//";
    let userMark = ":>";
    let aiMark = "!>";
    let askMark = "??";
    let aiAnswer = "\n!>\n$&";
    let isOp = false;
    let op: string[] = [];
    let aiM: aim = [];
    let aiConfig: aiconfig = _config || { type: "chatgpt" };
    l.push(newMark);
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
    for (let n = dataStart; n < l.length; n++) {
        const i = l[n];
        if (i.startsWith(aiMark)) {
            aiM.push({ role: "assistant", content: i.replace(aiMark, "").trim() });
        } else if (i.startsWith(userMark)) {
            aiM.push({ role: "user", content: i.replace(userMark, "").trim() });
        } else if (i === askMark) {
            break;
        } else if (i.startsWith(ignoreMark)) {
            index += i.length + 1;
            continue;
        } else if (i === newMark) {
            // ask 在 new 之前检测，换句话，若到了new无ask，则抛弃
            aiM = [];
        } else {
            if (aiM.length) {
                aiM.at(-1).content += "\n" + i;
            } else {
                aiM.push({ role: "system", content: i });
            }
        }

        index += i.length;
    }
    if (aiM.length === 0) return;
    console.log(aiM);
    if (!aiConfig.type) aiConfig.type = "chatgpt";
    return { ai: aiM, option: { index: index + 1, askMark, aiAnswer, config: aiConfig } };
}
