import { Listener } from "@sapphire/framework";

const responses = [
    {
        triggers: ["may the 4th", "may the fourth"],
        response: "May the Fourth be with you. ✨ And also with you, young Padawan.",
    },
    {
        triggers: ["r2d2", "r2 noises"],
        response: "That's an older code, but it checks out.",
    },
    {
        triggers: ["pew pew", "laser", "blaster"],
        response: "Han shot first. End of story. 🔫",
    },
    {
        triggers: ["mace", "crossbow"],
        response: "I have a bad feeling about this...",
    },
    {
        triggers: ["high ground"],
        response: "It's over Anakin, I have the high ground... and a mace.",
    },
    {
        triggers: ["sand"],
        response: "I don't like sand. It's coarse and rough and irritating... and it gets everywhere.",
    },
    {
        triggers: ["magic hand"],
        response: "Come on, baby, do the magic hand thing. ✨",
    },
    {
        triggers: ["lack of faith"],
        response: "I find your lack of faith disturbing... 😤",
    },
    {
        triggers: ["come to the dark side"],
        response: "We have cookies. 🍪",
    },
    {
        triggers: ["this is the way"],
        response: "This is the way. 🛡️",
    },
];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole words only, so "sand" does not fire on "thousand" or "sandwich".
const matchers = responses.map(({ triggers, response }) => ({
    pattern: new RegExp(`\\b(?:${triggers.map(escapeRegExp).join("|")})\\b`, "i"),
    response,
}));

/** The May 4th reply for a message, or null when nothing matches. */
export function findMayFourthResponse(content) {
    const text = String(content || "");
    const match = matchers.find(({ pattern }) => pattern.test(text));
    return match ? match.response : null;
}

export class GuildMessageListener extends Listener {
    constructor(context, options) {
        super(context, {
            ...options,
            once: false,
            event: "messageCreate",
        });
    }

    run(message) {
        if (message.author.bot) return;

        const now = new Date();
        const isMayFourth = now.getMonth() === 4 && now.getDate() === 4;

        if (!isMayFourth) return;

        const response = findMayFourthResponse(message.content);
        if (response) {
            message.channel.send(response).catch((error) => {
                console.warn("[may4th] Failed to reply:", error.message);
            });
        }
    }
}
