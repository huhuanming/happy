import { z } from "zod";
import { Fastify } from "../types";
import { FeedBodySchema } from "@/app/feed/types";
import { feedGet } from "@/app/feed/feedGet";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { userDataCache } from "@/storage/userDataCache";

export function feedRoutes(app: Fastify) {
    app.get('/v1/feed', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                before: z.string().optional(),
                after: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }).optional(),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        id: z.string(),
                        body: FeedBodySchema,
                        repeatKey: z.string().nullable(),
                        cursor: z.string(),
                        createdAt: z.number()
                    })),
                    hasMore: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { before, after } = request.query ?? {};

        // Only cache the default (no-cursor) initial load
        if (!before && !after) {
            const cached = userDataCache.get<any>('feed', userId);
            if (cached) return reply.send(cached);
        }

        const items = await feedGet(db, Context.create(userId), {
            cursor: { before, after },
            limit: request.query?.limit
        });
        const response = { items: items.items, hasMore: items.hasMore };

        if (!before && !after) {
            userDataCache.set('feed', userId, response);
        }
        return reply.send(response);
    });
}