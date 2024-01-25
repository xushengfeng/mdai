import { watchFile, readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import YAML from "yaml";

let configPath = path.join(homedir(), "mdai", "config.json");
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
        let answer = await aix.text;
        answer = answer.replace(/^.*$/, p.option.aiAnswer);
    } catch (error) {
        console.error(error);
        answer = error;
    }
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
            messages: m,
        },
    };
    let gemini = {
        url: config.url || "",
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
    }
    if (config.type === "gemini") {
        url = gemini.url;
        for (let i in config.option) {
            con[i] = config.option[i];
        }
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
                        let answer = t.choices[0].message.content;
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
    let userMark = ">";
    let aiMark = "ai:";
    let askMark = "??";
    let aiAnswer = "ai:\n$0";
    let isOp = false;
    let op: string[] = [];
    let aiM: aim = [];
    let aiConfig: aiconfig = _config || { type: "chatgpt" };
    l.push(newMark);
    for (let i of l) {
        if (i === opMark) {
            isOp = !isOp;
            if (!isOp) {
                let option = YAML.parse(op.join("\n"));
                console.log(option);
                ignoreMark = option["ignore"] || ignoreMark;
                userMark = option["user"] || userMark;
                aiMark = option["ai"] || aiMark;
                askMark = option["ask"] || askMark;
                aiAnswer = option["answer"] || aiAnswer;
                aiConfig = Object.assign(aiConfig, option["config"]);
            }
        }
        if (isOp) {
            op.push(i);
        } else {
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
        }
    }
    if (aiM.length === 0) return;
    console.log(aiM);
    return { ai: aiM, option: { index: index, askMark, aiAnswer, config: aiConfig } };
}
