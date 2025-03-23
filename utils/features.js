import { v2 as cloudinary } from "cloudinary";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { v4 as uuid } from "uuid";
import { getBase64, getSockets } from "../lib/helper.js";

const cookieOptions = {
  maxAge: 15 * 24 * 60 * 60 * 1000,
  sameSite: "none",
  httpOnly: true,
  secure: true,
  domain: process.env.NODE_ENV === 'production' ? undefined : undefined,
  path: '/'
};

const connectDB = (uri) => {
  mongoose
    .connect(uri, { dbName: "Chattu" })
    .then((data) => {
      console.log(`Connected to DB: ${data.connection.host}`);
    })
    .catch((err) => {
      throw err;
    });
};

const sendToken = (res, user, code, message) => {
  const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

  return res.status(code).cookie("chattu-token", token, cookieOptions).json({
    success: true,
    user,
    message,
  });
};

const emitEvent = (req, event, users, data) => {
  const io = req.app.get("io");
  const usersSocket = getSockets(users);
  io.to(usersSocket).emit(event, data); // Emit event to users
};

const uploadFilesToCloudinary = async (files = []) => {
  console.log("Files Received for Upload:", files.length);

  const uploadPromises = files.map((file) => {
    const base64String = getBase64(file);  // function below
    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload(
        base64String,
        { resource_type: "auto", public_id: uuid() },
        (error, result) => {
          if (error) {
            console.error("Cloudinary Upload Error:", error);
            return reject(error);
          }
          resolve(result);
        }
      );
    });
  });

  const results = await Promise.all(uploadPromises);
  return results.map((res) => ({ public_id: res.public_id, url: res.secure_url }));
};

const deletFilesFromCloudinary = async (public_ids) => {
  // Delete files from cloudinary
};

export {
    connectDB, cookieOptions, deletFilesFromCloudinary, emitEvent, sendToken, uploadFilesToCloudinary
};

