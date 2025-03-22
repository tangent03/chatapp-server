import express from "express";
import {
    acceptFriendRequest,
    getMyFriends,
    getMyNotifications,
    getMyProfile,
    login,
    logout,
    newUser,
    searchUser,
    sendFriendRequest,
} from "../controllers/user.js";
import {
    acceptRequestValidator,
    loginValidator,
    registerValidator,
    sendRequestValidator,
    validateHandler,
} from "../lib/validators.js";
import { isAuthenticated } from "../middlewares/auth.js";
import { singleAvatar } from "../middlewares/multer.js";
import { User } from "../models/user.js";
import { ErrorHandler, asyncHandler } from "../utils/utility.js";

const app = express.Router();

app.post("/new", singleAvatar, registerValidator(), validateHandler, newUser);
app.post("/login", loginValidator(), validateHandler, login);

// After here user must be logged in to access the routes

app.use(isAuthenticated);

app.get("/me", getMyProfile);

app.get("/logout", logout);

app.get("/search", searchUser);

app.put(
  "/sendrequest",
  sendRequestValidator(),
  validateHandler,
  sendFriendRequest
);

app.put(
  "/acceptrequest",
  acceptRequestValidator(),
  validateHandler,
  acceptFriendRequest
);

app.get("/notifications", getMyNotifications);

app.get("/friends", getMyFriends);

// Add a new route to handle bio updates
app.put("/bio", isAuthenticated, asyncHandler(async (req, res, next) => {
  try {
    const { bio } = req.body;
    
    // Allow empty string for clearing bio
    if (bio === undefined) 
      return next(new ErrorHandler("Bio must be provided", 400));
    
    // Update user bio in the database
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { bio },
      { new: true, runValidators: true }
    );
    
    if (!updatedUser) 
      return next(new ErrorHandler("User not found", 404));
    
    res.status(200).json({
      success: true,
      message: "Bio updated successfully"
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
}));

export default app;