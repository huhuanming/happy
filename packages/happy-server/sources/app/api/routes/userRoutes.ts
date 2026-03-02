import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile } from "@/app/social/type";
import { userDataCache } from "@/storage/userDataCache";

export async function userRoutes(app: Fastify) {

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { id } = request.params;

        // Fetch user
        const user = await db.account.findUnique({
            where: {
                id: id
            },
            include: {
                githubUser: true
            }
        });

        if (!user) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Resolve relationship status
        const relationship = await db.userRelationship.findFirst({
            where: {
                fromUserId: request.userId,
                toUserId: id
            }
        });
        const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

        // Build user profile
        return reply.send({
            user: buildUserProfile(user, status)
        });
    });

    // Search for users
    app.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string()
            }),
            response: {
                200: z.object({
                    users: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { query } = request.query;

        // Search for users by username, first 10 matches
        const users = await db.account.findMany({
            where: {
                username: {
                    startsWith: query,
                    mode: 'insensitive'
                }
            },
            include: {
                githubUser: true
            },
            take: 10,
            orderBy: {
                username: 'asc'
            }
        });

        // Resolve relationship status for each user
        const userProfiles = await Promise.all(users.map(async (user) => {
            const relationship = await db.userRelationship.findFirst({
                where: {
                    fromUserId: request.userId,
                    toUserId: user.id
                }
            });
            const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;
            return buildUserProfile(user, status);
        }));

        return reply.send({
            users: userProfiles
        });
    });

    // Add friend
    app.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendAdd(Context.create(request.userId), request.body.uid);
        userDataCache.invalidate('friends', request.userId);
        userDataCache.invalidate('friends', request.body.uid);
        return reply.send({ user });
    });

    app.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: z.string()
            }),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const user = await friendRemove(Context.create(request.userId), request.body.uid);
        userDataCache.invalidate('friends', request.userId);
        userDataCache.invalidate('friends', request.body.uid);
        return reply.send({ user });
    });

    app.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const cached = userDataCache.get<any>('friends', userId);
        if (cached) return reply.send(cached);

        const friends = await friendList(Context.create(userId));
        const response = { friends };
        userDataCache.set('friends', userId, response);
        return reply.send(response);
    });
};

// Shared Zod Schemas
const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: RelationshipStatusSchema
});