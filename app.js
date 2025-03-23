import { v2 as cloudinary } from "cloudinary";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { corsOptions } from "./constants/config.js";
import {
    CALL_ACCEPTED,
    CALL_ENDED,
    CALL_REJECTED,
    CALL_REQUEST,
    CHAT_JOINED,
    CHAT_LEAVED,
    ICE_CANDIDATE,
    MESSAGE_REACTION,
    MESSAGE_SEEN,
    NEW_MESSAGE,
    NEW_MESSAGE_ALERT,
    ONLINE_USERS,
    START_TYPING,
    STOP_TYPING,
    WEBRTC_ANSWER,
    WEBRTC_OFFER,
} from "./constants/events.js";
import { getSockets } from "./lib/helper.js";
import { socketAuthenticator } from "./middlewares/auth.js";
import { errorMiddleware } from "./middlewares/error.js";
import { Message } from "./models/message.js";
import { connectDB } from "./utils/features.js";

import adminRoute from "./routes/admin.js";
import chatRoute from "./routes/chat.js";
import userRoute from "./routes/user.js";

dotenv.config({
  path: "./.env",
});

const mongoURI = process.env.MONGO_URI;
const port = process.env.PORT || 3000;
const envMode = process.env.NODE_ENV.trim() || "PRODUCTION";
const adminSecretKey = process.env.ADMIN_SECRET_KEY || "adsasdsdfsdfsdfd";
const userSocketIDs = new Map();
const onlineUsers = new Set();

connectDB(mongoURI);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: corsOptions,
});

app.set("io", io);

// Set allowed origins based on environment
const allowedOrigins = process.env.NODE_ENV === 'production' 
  ? [process.env.FRONTEND_URL, 'https://chatapp-frontend-eosin-beta.vercel.app'] 
  : ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000'];

// Configure CORS
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true, // Allow cookies to be sent with requests
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(cookieParser());

app.use("/api/v1/user", userRoute);
app.use("/api/v1/chat", chatRoute);
app.use("/api/v1/admin", adminRoute);

app.get("/", (req, res) => {
  res.send("Hello World");
});

io.use((socket, next) => {
  cookieParser()(
    socket.request,
    socket.request.res,
    async (err) => await socketAuthenticator(err, socket, next)
  );
});

io.on("connection", (socket) => {
  const user = socket.user;
  console.log(`User connected: ${user._id} (${user.name}), Socket ID: ${socket.id}`);
  userSocketIDs.set(user._id.toString(), socket.id);
  
  // Broadcast online status when a user connects
  onlineUsers.add(user._id.toString());
  socket.broadcast.emit(ONLINE_USERS, Array.from(onlineUsers));
  
  // Send current online users to the newly connected user
  socket.emit(ONLINE_USERS, Array.from(onlineUsers));

  socket.on(NEW_MESSAGE, async ({ chatId, members, message }) => {
    try {
      // Create DB message first
      const messageForDB = {
        content: message,
        sender: user._id,
        chat: chatId,
        reactions: [],
        seen: false,
      };
      
      // Save message to database first before emitting
      const savedMessage = await Message.create(messageForDB);
      
      if (!savedMessage || !savedMessage._id) {
        throw new Error("Failed to save message to database");
      }
      
      // Now create the real-time message with the actual DB ID
      const messageForRealTime = {
        content: message,
        _id: savedMessage._id,
        sender: {
          _id: user._id,
          name: user.name,
        },
        chat: chatId,
        createdAt: new Date().toISOString(),
        reactions: [],
        seen: false,
      };

      // Get member socket IDs
      const membersSocket = getSockets(members);
      
      // Send to all members including sender for consistency
      io.to(membersSocket).emit(NEW_MESSAGE, {
        chatId,
        message: messageForRealTime,
      });
      
      // Send alert to all chat members except sender
      const otherMembersSocket = members
        .filter(m => m.toString() !== user._id.toString())
        .map(m => userSocketIDs.get(m.toString()))
        .filter(Boolean);
        
      io.to(otherMembersSocket).emit(NEW_MESSAGE_ALERT, { chatId });
      
    } catch (error) {
      console.error("Error saving message:", error);
      // Notify only the sender about the error
      socket.emit("ERROR", { 
        message: "Failed to save message", 
        error: error.message 
      });
    }
  });

  socket.on(START_TYPING, ({ members, chatId }) => {
    const membersSockets = getSockets(members);
    socket.to(membersSockets).emit(START_TYPING, { chatId });
  });

  socket.on(STOP_TYPING, ({ members, chatId }) => {
    const membersSockets = getSockets(members);
    socket.to(membersSockets).emit(STOP_TYPING, { chatId });
  });

  // Handle message reactions
  socket.on(MESSAGE_REACTION, async ({ messageId, reaction, userId }) => {
    try {
      // Find the message in database
      const message = await Message.findById(messageId);
      if (!message) {
        return;
      }
      
      // Import Chat model dynamically to avoid circular dependency
      const Chat = mongoose.model('Chat');
      
      // Get chat members to notify them
      const chat = await Chat.findById(message.chat);
      if (!chat) {
        return;
      }
      
      // Ensure reactions array exists and is valid
      let reactions = [];
      if (Array.isArray(message.reactions)) {
        reactions = [...message.reactions];
      }
      
      // Validate userId and reaction
      if (!userId || !reaction) {
        return;
      }
      
      // Check if user already reacted with this emoji
      const existingReactionIndex = reactions.findIndex(
        r => r.userId && r.userId.toString() === userId.toString() && r.emoji === reaction
      );
      
      if (existingReactionIndex >= 0) {
        // Remove reaction if it exists
        reactions = reactions.filter((_, index) => index !== existingReactionIndex);
      } else {
        // Add new reaction
        reactions.push({ userId, emoji: reaction });
      }
      
      // Update message in database using findByIdAndUpdate to avoid validation
      await Message.findByIdAndUpdate(
        messageId,
        { $set: { reactions } },
        { new: true, runValidators: false }
      );
      
      // Group reactions by emoji and count them
      const groupedReactions = reactions.reduce((acc, curr) => {
        if (!curr || !curr.emoji) return acc;
        
        const existing = acc.find(r => r.emoji === curr.emoji);
        if (existing) {
          existing.count += 1;
          if (curr.userId) {
            existing.users.push(curr.userId.toString());
          }
        } else {
          acc.push({ 
            emoji: curr.emoji, 
            count: 1, 
            users: curr.userId ? [curr.userId.toString()] : [] 
          });
        }
        return acc;
      }, []);
      
      // Notify all members
      const membersSockets = getSockets(chat.members);
      io.to(membersSockets).emit(MESSAGE_REACTION, {
        messageId,
        chatId: message.chat.toString(),
        reactions: groupedReactions,
      });
    } catch (error) {
      console.error("Error handling reaction:", error);
    }
  });
  
  // Handle message seen status
  socket.on(MESSAGE_SEEN, async ({ messageId, chatId, userId }) => {
    try {
      // Use findOneAndUpdate instead of find + save to avoid validation errors
      const result = await Message.findByIdAndUpdate(
        messageId, 
        { $set: { seen: true } },
        { new: true, runValidators: false }
      );
      
      if (!result) {
        return;
      }
      
      // Import Chat model dynamically to avoid circular dependency
      const Chat = mongoose.model('Chat');
      
      // Get chat to notify members
      const chat = await Chat.findById(chatId);
      if (!chat) {
        return;
      }
      
      // Notify all members
      const membersSockets = getSockets(chat.members);
      io.to(membersSockets).emit(MESSAGE_SEEN, {
        messageId,
        chatId,
        seen: true,
      });
    } catch (error) {
      console.error("Error handling seen status:", error);
    }
  });

  socket.on(CHAT_JOINED, ({ userId, members }) => {
    onlineUsers.add(userId.toString());

    const membersSocket = getSockets(members);
    io.to(membersSocket).emit(ONLINE_USERS, Array.from(onlineUsers));
  });

  socket.on(CHAT_LEAVED, ({ userId, members }) => {
    onlineUsers.delete(userId.toString());

    const membersSocket = getSockets(members);
    io.to(membersSocket).emit(ONLINE_USERS, Array.from(onlineUsers));
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${user._id} (${user.name})`);
    userSocketIDs.delete(user._id.toString());
    onlineUsers.delete(user._id.toString());
    io.emit(ONLINE_USERS, Array.from(onlineUsers));
  });

  // WebRTC Call Events
  socket.on(CALL_REQUEST, (data) => {
    // Check if receiverId exists
    if (!data.receiverId) {
      console.error('Missing receiverId in call request:', data);
      socket.emit(CALL_REJECTED, {
        to: data.callerId,
        message: 'Invalid call request: Missing receiverId'
      });
      return;
    }
    
    // Get receiver's socket ID
    const receiverSocketId = userSocketIDs.get(data.receiverId.toString());
    
    if (receiverSocketId) {
      // Forward call request to receiver
      io.to(receiverSocketId).emit(CALL_REQUEST, data);
    } else {
      // Receiver not online, send rejection
      socket.emit(CALL_REJECTED, {
        to: data.callerId,
        from: data.receiverId,
        message: 'User is offline'
      });
    }
  });

  socket.on(CALL_ACCEPTED, (data) => {
    // Get caller's socket ID
    const callerSocketId = userSocketIDs.get(data.to.toString());
    
    if (callerSocketId) {
      // Forward acceptance to caller
      io.to(callerSocketId).emit(CALL_ACCEPTED, data);
    }
  });

  socket.on(CALL_REJECTED, (data) => {
    // Get caller's socket ID
    const callerSocketId = userSocketIDs.get(data.to.toString());
    
    if (callerSocketId) {
      // Forward rejection to caller
      io.to(callerSocketId).emit(CALL_REJECTED, data);
    }
  });

  socket.on(CALL_ENDED, ({ to, from }) => {
    if (!to || !from) {
      console.error('Missing to or from in CALL_ENDED event');
      return;
    }
    
    // Get the socket ID of the target user
    const toSocketId = userSocketIDs.get(to.toString());
    
    if (toSocketId) {
      io.to(toSocketId).emit(CALL_ENDED, { from });
    } else {
      console.error(`No socket ID found for recipient: ${to}`);
    }
  });

  socket.on(ICE_CANDIDATE, (data) => {
    // Get receiver's socket ID
    const receiverSocketId = userSocketIDs.get(data.to.toString());
    
    if (receiverSocketId) {
      // Forward ICE candidate to receiver
      io.to(receiverSocketId).emit(ICE_CANDIDATE, data);
    }
  });

  socket.on(WEBRTC_OFFER, (data) => {
    // Get receiver's socket ID
    const receiverSocketId = userSocketIDs.get(data.to.toString());
    
    if (receiverSocketId) {
      // Forward offer to receiver
      io.to(receiverSocketId).emit(WEBRTC_OFFER, data);
    }
  });

  socket.on(WEBRTC_ANSWER, (data) => {
    // Get caller's socket ID
    const callerSocketId = userSocketIDs.get(data.to.toString());
    
    if (callerSocketId) {
      // Forward answer to caller
      io.to(callerSocketId).emit(WEBRTC_ANSWER, data);
    }
  });
});

app.use(errorMiddleware);

server.listen(port, () => {
  console.log(`Server is running on port ${port} in ${envMode} Mode`);
});

export { adminSecretKey, envMode, userSocketIDs };

