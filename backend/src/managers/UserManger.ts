import { Socket } from "socket.io";
import { RoomManager } from "./RoomManager";

export interface User {
    socket: Socket;
    name: string;
    country?: string;
    language?: string;
    topics: string[];
    profilePhoto?: string;
}

export class UserManager {
    private users: User[];
    private queue: string[];
    private roomManager: RoomManager;
    
    constructor() {
        this.users = [];
        this.queue = [];
        this.roomManager = new RoomManager();
    }

    addUser(name: string, socket: Socket) {
        const user: User = {
            name, 
            socket,
            topics: ['general'] // Default topic
        };
        
        this.users.push(user);
        this.queue.push(socket.id);
        socket.emit("lobby");
        this.initHandlers(socket);
    }

    updateUserInfo(socketId: string, userInfo: {name: string, country: string, topics: string[], language: string, profilePhoto?: string}) {
        const user = this.users.find(x => x.socket.id === socketId);
        if (user) {
            user.name = userInfo.name;
            user.country = userInfo.country;
            user.language = userInfo.language;
            user.topics = userInfo.topics;
            user.profilePhoto = userInfo.profilePhoto;
            
            // Try to match with someone after updating info
            this.clearQueue();
        }
    }

    removeUser(socketId: string) {
        const user = this.users.find(x => x.socket.id === socketId);
        
        if (user) {
            console.log(`User ${user.name} (${socketId}) is disconnecting`);
            
            // Notify room manager about disconnection first
            this.roomManager.onUserDisconnected(socketId);
        }
        
        // Remove user from users list and queue
        this.users = this.users.filter(x => x.socket.id !== socketId);
        this.queue = this.queue.filter(x => x !== socketId);
        
        console.log(`User removed. Remaining users: ${this.users.length}, Queue: ${this.queue.length}`);
    }

    findCompatibleUser(currentUser: User): User | null {
        // Find users with at least one matching topic and not blocked
        const compatibleUsers = this.queue
            .filter(id => id !== currentUser.socket.id)
            .map(id => this.users.find(u => u.socket.id === id))
            .filter((user): user is User => 
                user !== undefined && 
                this.hasMatchingTopics(currentUser, user) &&
                !this.roomManager.areUsersBlocked(currentUser.socket.id, user.socket.id)
            );
        
        return compatibleUsers.length > 0 ? compatibleUsers[0] : null;
    }

    hasMatchingTopics(user1: User, user2: User): boolean {
        return user1.topics.some(topic => user2.topics.includes(topic));
    }

    clearQueue() {
        console.log("inside clear queues");
        console.log("Queue length:", this.queue.length);
        
        if (this.queue.length < 2) {
            console.log("Not enough users in queue to match");
            return;
        }

        // Try to find compatible users
        const processedUsers = new Set<string>();
        
        for (const userId of this.queue) {
            if (processedUsers.has(userId)) continue;
            
            const user1 = this.users.find(x => x.socket.id === userId);
            if (!user1) continue;
            
            const user2 = this.findCompatibleUser(user1);
            if (!user2 || processedUsers.has(user2.socket.id)) continue;
            
            console.log(`Matching users with topics: ${user1.topics.join(',')} and ${user2.topics.join(',')}`);
            
            // Remove both users from queue
            this.queue = this.queue.filter(id => id !== user1.socket.id && id !== user2.socket.id);
            processedUsers.add(user1.socket.id);
            processedUsers.add(user2.socket.id);
            
            // Share user info between matched users
            user1.socket.emit('remote-user-info', {
                name: user2.name,
                country: user2.country,
                language: user2.language,
                topics: user2.topics
            });
            
            user2.socket.emit('remote-user-info', {
                name: user1.name,
                country: user1.country,
                language: user1.language,
                topics: user1.topics
            });
            
            // Create room
            this.roomManager.createRoom(user1, user2);
            
            // Continue processing
            this.clearQueue();
            break;
        }
    }

    initHandlers(socket: Socket) {
        socket.on("user-info", (userInfo: {name: string, country: string, topics: string[], language: string, profilePhoto?: string}) => {
            this.updateUserInfo(socket.id, userInfo);
        });

        socket.on("offer", ({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onOffer(roomId, sdp, socket.id);
        });

        socket.on("answer",({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onAnswer(roomId, sdp, socket.id);
        });

        socket.on("add-ice-candidate", ({candidate, roomId, type}) => {
            this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
        });

        socket.on("chat-message", ({message, timestamp}) => {
            this.roomManager.onChatMessage(socket.id, message, timestamp);
        });

        socket.on("accept-match", ({roomId}) => {
            this.roomManager.onAcceptMatch(roomId, socket.id);
        });

        socket.on("reject-match", ({roomId}) => {
            this.roomManager.onRejectMatch(roomId, socket.id);
        });

        socket.on("skip-user", () => {
            this.roomManager.onSkipUser(socket.id);
        });
    }
}