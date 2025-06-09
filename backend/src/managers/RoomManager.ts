import { User } from "./UserManger";

let GLOBAL_ROOM_ID = 1;

interface Room {
    user1: User,
    user2: User,
    user1Accepted: boolean,
    user2Accepted: boolean,
    status: 'pending' | 'accepted' | 'active',
    autoSkipTimer?: NodeJS.Timeout
}

interface BlockedPair {
    user1Id: string,
    user2Id: string,
    blockedUntil: number,
    skipCount: number
}

export class RoomManager {
    private rooms: Map<string, Room>
    private blockedPairs: BlockedPair[]
    constructor() {
        this.rooms = new Map<string, Room>()
        this.blockedPairs = []
    }

    createRoom(user1: User, user2: User) {
        const roomId = this.generate().toString();
        this.rooms.set(roomId.toString(), {
            user1, 
            user2,
            user1Accepted: false,
            user2Accepted: false,
            status: 'pending'
        })

        // Send match notification with user data instead of immediate offer
        user1.socket.emit("match-found", {
            roomId,
            partnerInfo: {
                name: user2.name,
                country: user2.country,
                language: user2.language,
                topics: user2.topics,
                profilePhoto: user2.profilePhoto
            }
        })

        user2.socket.emit("match-found", {
            roomId,
            partnerInfo: {
                name: user1.name,
                country: user1.country,
                language: user1.language,
                topics: user1.topics,
                profilePhoto: user1.profilePhoto
            }
        })

        // Set auto-skip timer for 5 seconds
        const room = this.rooms.get(roomId);
        if (room) {
            room.autoSkipTimer = setTimeout(() => {
                this.autoSkipMatch(roomId);
            }, 5000);
        }
    }

    onOffer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2: room.user1;
        receivingUser?.socket.emit("offer", {
            sdp,
            roomId
        })
    }
    
    onAnswer(roomId: string, sdp: string, senderSocketid: string) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2: room.user1;

        receivingUser?.socket.emit("answer", {
            sdp,
            roomId
        });
    }

    onIceCandidates(roomId: string, senderSocketid: string, candidate: any, type: "sender" | "receiver") {
        const room = this.rooms.get(roomId);
        if (!room) {
            return;
        }
        const receivingUser = room.user1.socket.id === senderSocketid ? room.user2: room.user1;
        receivingUser.socket.emit("add-ice-candidate", ({candidate, type}));
    }

    onChatMessage(senderSocketId: string, message: string, timestamp: string) {
        // Find the room containing the sender
        let targetRoom: Room | null = null;
        let receivingUser: User | null = null;

        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === senderSocketId) {
                targetRoom = room;
                receivingUser = room.user2;
                break;
            } else if (room.user2.socket.id === senderSocketId) {
                targetRoom = room;
                receivingUser = room.user1;
                break;
            }
        }

        if (targetRoom && receivingUser) {
            receivingUser.socket.emit("chat-message", {
                message,
                timestamp,
                sender: 'remote'
            });
        }
    }

    onUserDisconnected(socketId: string) {
        // Find the room containing the disconnected user
        let roomToRemove: string | null = null;
        let otherUser: User | null = null;

        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId) {
                otherUser = room.user2;
                roomToRemove = roomId;
                break;
            } else if (room.user2.socket.id === socketId) {
                otherUser = room.user1;
                roomToRemove = roomId;
                break;
            }
        }

        if (roomToRemove && otherUser) {
            // Notify the other user that their partner disconnected
            otherUser.socket.emit("user-disconnected", {
                message: "Your chat partner has disconnected"
            });
            
            // Put the other user back in lobby
            otherUser.socket.emit("lobby");
            
            // Remove the room
            this.rooms.delete(roomToRemove);
            
            console.log(`Room ${roomToRemove} deleted due to user disconnection`);
        }
    }

    onAcceptMatch(roomId: string, socketId: string) {
        const room = this.rooms.get(roomId);
        if (!room || room.status !== 'pending') {
            return;
        }

        const acceptingUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        if (room.user1.socket.id === socketId) {
            room.user1Accepted = true;
        } else if (room.user2.socket.id === socketId) {
            room.user2Accepted = true;
        }

        // If both users accepted, start the WebRTC connection
        if (room.user1Accepted && room.user2Accepted) {
            room.status = 'accepted';
            
            // Clear auto-skip timer since both accepted
            if (room.autoSkipTimer) {
                clearTimeout(room.autoSkipTimer);
                room.autoSkipTimer = undefined;
            }
            
            // Now send the actual WebRTC offers
            room.user1.socket.emit("send-offer", { roomId });
            room.user2.socket.emit("send-offer", { roomId });
            
            // Notify both users that the match was accepted
            room.user1.socket.emit("match-accepted", { roomId });
            room.user2.socket.emit("match-accepted", { roomId });
        } else {
            // One user accepted, notify the other user
            otherUser.socket.emit("partner-accepted", {
                partnerName: acceptingUser.name,
                roomId
            });
        }
    }

    onRejectMatch(roomId: string, socketId: string) {
        const room = this.rooms.get(roomId);
        if (!room || room.status !== 'pending') {
            return;
        }

        // Clear auto-skip timer since someone manually rejected
        if (room.autoSkipTimer) {
            clearTimeout(room.autoSkipTimer);
            room.autoSkipTimer = undefined;
        }

        const rejectingUser = room.user1.socket.id === socketId ? room.user1 : room.user2;
        const otherUser = room.user1.socket.id === socketId ? room.user2 : room.user1;

        // Notify the other user that the match was rejected
        otherUser.socket.emit("match-rejected");
        
        // Put both users back in lobby
        rejectingUser.socket.emit("lobby");
        otherUser.socket.emit("lobby");
        
        // Remove the room
        this.rooms.delete(roomId);
    }

    autoSkipMatch(roomId: string) {
        const room = this.rooms.get(roomId);
        if (!room || room.status !== 'pending') {
            return;
        }

        console.log(`Auto-skipping match after 5 seconds for room ${roomId}`);
        
        // Notify both users about auto-skip
        room.user1.socket.emit("match-auto-skipped", {
            message: "Match timed out. Looking for someone else..."
        });
        
        room.user2.socket.emit("match-auto-skipped", {
            message: "Match timed out. Looking for someone else..."
        });

        // Put both users back in lobby
        room.user1.socket.emit("lobby");
        room.user2.socket.emit("lobby");

        // Remove the room
        this.rooms.delete(roomId);
    }

    onSkipUser(socketId: string) {
        // Find the room containing the user who wants to skip
        let targetRoom: Room | null = null;
        let skippingUser: User | null = null;
        let otherUser: User | null = null;

        for (const [roomId, room] of this.rooms.entries()) {
            if (room.user1.socket.id === socketId) {
                targetRoom = room;
                skippingUser = room.user1;
                otherUser = room.user2;
                break;
            } else if (room.user2.socket.id === socketId) {
                targetRoom = room;
                skippingUser = room.user2;
                otherUser = room.user1;
                break;
            }
        }

        if (targetRoom && skippingUser && otherUser) {
            // Add to blocked pairs with increasing time
            this.addBlockedPair(skippingUser.socket.id, otherUser.socket.id);

            // Notify both users about the skip
            skippingUser.socket.emit("user-skipped", {
                message: "You skipped this user. Looking for someone new..."
            });
            
            otherUser.socket.emit("user-skipped", {
                message: "The other user skipped. Looking for someone new..."
            });

            // Put both users back in lobby
            skippingUser.socket.emit("lobby");
            otherUser.socket.emit("lobby");

            // Remove the room
            const roomIdToDelete = [...this.rooms.entries()].find(([_, room]) => room === targetRoom)?.[0];
            if (roomIdToDelete) {
                this.rooms.delete(roomIdToDelete);
            }

            console.log(`Room deleted due to user skip`);
        }
    }

    private addBlockedPair(userId1: string, userId2: string) {
        // Clean expired blocks first
        this.cleanExpiredBlocks();

        // Check if this pair already exists
        let existingPair = this.blockedPairs.find(pair => 
            (pair.user1Id === userId1 && pair.user2Id === userId2) ||
            (pair.user1Id === userId2 && pair.user2Id === userId1)
        );

        if (existingPair) {
            // Increase skip count and extend block time
            existingPair.skipCount++;
            // 5 minutes base + 5 minutes for each additional skip
            const blockDuration = 5 * 60 * 1000 * existingPair.skipCount; // in milliseconds
            existingPair.blockedUntil = Date.now() + blockDuration;
            console.log(`Extended block for users ${userId1} and ${userId2}. Block count: ${existingPair.skipCount}, Duration: ${blockDuration/60000} minutes`);
        } else {
            // Create new block (5 minutes)
            const blockDuration = 5 * 60 * 1000; // 5 minutes in milliseconds
            this.blockedPairs.push({
                user1Id: userId1,
                user2Id: userId2,
                blockedUntil: Date.now() + blockDuration,
                skipCount: 1
            });
            console.log(`Blocked users ${userId1} and ${userId2} for ${blockDuration/60000} minutes`);
        }
    }

    private cleanExpiredBlocks() {
        const now = Date.now();
        this.blockedPairs = this.blockedPairs.filter(pair => pair.blockedUntil > now);
    }

    areUsersBlocked(userId1: string, userId2: string): boolean {
        this.cleanExpiredBlocks();
        return this.blockedPairs.some(pair => 
            (pair.user1Id === userId1 && pair.user2Id === userId2) ||
            (pair.user1Id === userId2 && pair.user2Id === userId1)
        );
    }

    generate() {
        return GLOBAL_ROOM_ID++;
    }

}