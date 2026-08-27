import { genericUserAgent } from "../../config.js";
import { resolveRedirectingURL } from "../url.js";
import { randomBytes } from "node:crypto";

const videoRegex = /"url":"(https:\/\/v1\.pinimg\.com\/videos\/.*?)"/g;
const imageRegex = /src="(https:\/\/i\.pinimg\.com\/(?:\d+x|orig)\/[0-9a-f/]{41}\.(jpg|gif))"/g;
const imageFallbackRegex = /src="(https:\/\/i\.pinimg\.com\/.*\.(jpg|gif))"/g;
const notFoundRegex = /"__typename"\s*:\s*"PinNotFound"/;

// /orig/ beats every /<width>x/ variant of the same image
function qualityScore(url) {
    if (url.includes("/orig/")) return Infinity;
    return Number(url.match(/\/(\d+)x\//)?.[1]) || 0;
}

function extractImageFromHTML(html) {
    const matches = [...html.matchAll(imageRegex)].map(([, link]) => link);

    if (!matches.length) {
        return [...html.matchAll(imageFallbackRegex)].map(([, link]) => link)[0];
    }

    // every resolution of a pin shares one hash, so keep the variants of the
    // first match (which is always the main image) and pick the largest one
    const hash = matches[0].match(/\/(?:\d+x|orig)\/([0-9a-f/]{41})\./)?.[1];
    if (!hash) return matches[0];

    return matches.filter(link => link.includes(hash))
                  .sort((a, b) => qualityScore(b) - qualityScore(a))[0];
}

async function extractImageFromGraphQL(id) {
    const csrf = randomBytes(16).toString("hex");

    const responseData = await fetch("https://www.pinterest.com/_/graphql/", {
        method: "POST",
        body: JSON.stringify({
            queryHash: "a5ebb2b085f4c3f33f14ebb7da5ca572bcde8549c478fdccfbaddbbac4f01b92",
            variables: {
                pinId: id,
                isAuth: false,
                isDesktop: true,
                shouldPrefetchStoryPinFragment: false,
                shouldSkipImageViewerOnPageQuery: false,
                isUnauth: true
            }
        }),
        headers: {
            "content-type": "application/json",
            "cookie": `csrftoken=${csrf}`,
            "user-agent": genericUserAgent,
            "x-csrftoken": csrf,
        },
    }).then(r => r.json()).catch(() => {});

    const pin = responseData?.data?.v3GetPinQueryv2;
    if (pin?.__typename !== "PinResponse") return;

    const pinData = pin.data ?? {};
    let bestQuality = pinData["images_orig"];

    if (!bestQuality) {
        for (const key of Object.keys(pinData)) {
            if (!key.startsWith("images_")) continue;

            const image = pinData[key];
            if (!image?.url) continue;

            const size = Math.max(image.height, image.width);
            const bestSize = bestQuality
                ? Math.max(bestQuality.height, bestQuality.width)
                : 0;

            if (size > bestSize) bestQuality = image;
        }
    }

    return bestQuality?.url;
}

export default async function(o) {
    let id = o.id;

    if (!o.id && o.shortLink) {
        const patternMatch = await resolveRedirectingURL(`https://api.pinterest.com/url_shortener/${o.shortLink}/redirect/`);
        id = patternMatch?.id;
    }

    if (id.includes("--")) id = id.split("--")[1];
    if (!id) return { error: "fetch.fail" };

    const html = await fetch(`https://www.pinterest.com/pin/${id}/`, {
        headers: { "user-agent": genericUserAgent }
    }).then(r => r.text()).catch(() => {});

    const invalidPin = html.match(notFoundRegex);

    if (invalidPin) return { error: "fetch.empty" };

    if (!html) return { error: "fetch.fail" };

    const videoLink = [...html.matchAll(videoRegex)]
                    .map(([, link]) => link)
                    .find(a => a.endsWith('.mp4'));

    if (videoLink) return {
        urls: videoLink,
        filename: `pinterest_${id}.mp4`,
        audioFilename: `pinterest_${id}_audio`
    }

    const imageLink = extractImageFromHTML(html) || await extractImageFromGraphQL(id);

    if (imageLink) {
        const imageType = imageLink.endsWith(".gif") ? "gif" : "jpg";

        return {
            urls: imageLink,
            isPhoto: true,
            filename: `pinterest_${id}.${imageType}`
        }
    }

    return { error: "fetch.empty" };
}
