// --- ĐOẠN CODE ĐỌC BIẾN MÔI TRƯỜNG ---
const credentials = process.env.CREDENTIALS_JSON 
    ? JSON.parse(process.env.CREDENTIALS_JSON) 
    : require('./credentials.json');

// Link redirect linh hoạt: chạy local thì dùng localhost, chạy web thì dùng link Render
const REDIRECT_URI = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL}/oauth2callback` 
    : 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
    credentials.web.client_id,
    credentials.web.client_secret,
    REDIRECT_URI
);

// Tự động nạp Token
if (process.env.TOKEN_JSON) {
    oauth2Client.setCredentials(JSON.parse(process.env.TOKEN_JSON));
} else {
    oauth2Client.setCredentials(JSON.parse(fs.readFileSync('token.json')));
}
// --- 2. CÁC HÀM HỖ TRỢ ---
async function deleteFromDrive(fileId) {
    try {
        await drive.files.delete({ fileId: fileId });
        console.log(`🗑️ Đã xóa file trên Drive: ${fileId}`);
    } catch (err) { console.error("Lỗi xóa file:", err.message); }
}

function updateRoomStatus(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    const size = room ? room.size : 0; 
    io.to(roomId).emit('user-count', size);

    if (size === 0 && roomsData[roomId]) {
        roomsData[roomId].blocks.forEach(block => {
            if (block.driveId) deleteFromDrive(block.driveId);
        });
        delete roomsData[roomId];
        console.log(`🧹 Đã dọn dẹp phòng trống ${roomId}`);
    }
}

// --- 3. ROUTE UPLOAD (STREAMING + CHÍNH CHỦ 5TB) ---
app.post('/upload', (req, res) => {
    const busboy = Busboy({ headers: req.headers });
    let roomId = '';

    busboy.on('field', (fieldname, val) => {
        if (fieldname === 'roomId') roomId = val;
    });

    busboy.on('file', (fieldname, file, info) => {
        const { filename, mimeType } = info;
        
        if (!roomsData[roomId]) {
            file.resume();
            return res.status(404).send('Phòng không tồn tại');
        }

        console.log(`📡 Đang đẩy [${filename}] lên 5TB chính chủ...`);

        drive.files.create({
            resource: { 'name': filename, 'parents': [GOOGLE_DRIVE_FOLDER_ID] },
            media: { mimeType: mimeType, body: file },
            uploadType: 'resumable',
            fields: 'id, webContentLink'
        }, async (err, response) => {
            if (err) {
                console.error("❌ Lỗi Drive:", err.message);
                return res.status(500).send('Lỗi: ' + err.message);
            }

            const fileId = response.data.id;

            // Cấp quyền công khai để máy khác tải được luôn
            try {
                await drive.permissions.create({
                    fileId: fileId,
                    requestBody: { role: 'reader', type: 'anyone' }
                });
            } catch (pErr) {}

            const newBlock = {
                id: 'block-' + Date.now(),
                type: 'file',
                content: response.data.webContentLink,
                fileName: filename,
                driveId: fileId,
                senderId: 'SERVER'
            };

            roomsData[roomId].blocks.push(newBlock);
            io.to(roomId).emit('block-added', newBlock);
            res.status(200).send('OK');
        });
    });

    req.pipe(busboy);
});

// Route callback (Giữ lại để phòng trường hợp bạn cần xác thực lại)
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('✅ Xác thực thành công!');
});

// --- 4. SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('create-room', () => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        roomsData[roomId] = { blocks: [] };
        socket.join(roomId);
        socket.emit('room-created', roomId);
        setTimeout(() => updateRoomStatus(roomId), 100);
    });

    socket.on('join-room', (roomId) => {
        roomId = roomId.toUpperCase();
        if (!roomsData[roomId]) roomsData[roomId] = { blocks: [] };
        socket.join(roomId);
        socket.emit('room-joined', { roomId, history: roomsData[roomId].blocks });
        setTimeout(() => updateRoomStatus(roomId), 100);
    });

    socket.on('add-block', (data) => {
        const newBlock = {
            id: 'block-' + Date.now(), type: data.type, content: data.content || '',
            fileName: data.fileName || '', senderId: socket.id
        };
        if (roomsData[data.roomId]) {
            roomsData[data.roomId].blocks.push(newBlock);
            io.to(data.roomId).emit('block-added', newBlock);
        }
    });

    socket.on('update-block', (data) => {
        const room = roomsData[data.roomId];
        if (room) {
            const block = room.blocks.find(b => b.id === data.blockId);
            if (block) { block.content = data.content; socket.to(data.roomId).emit('block-updated', data); }
        }
    });

    socket.on('delete-block', (data) => {
        const room = roomsData[data.roomId];
        if (room) {
            const blockToDelete = room.blocks.find(b => b.id === data.blockId);
            if (blockToDelete && blockToDelete.driveId) deleteFromDrive(blockToDelete.driveId);
            room.blocks = room.blocks.filter(b => b.id !== data.blockId);
            io.to(data.roomId).emit('block-deleted', data.blockId);
        }
    });

    socket.on('destroy-room', (roomId) => {
        if (roomsData[roomId]) {
            roomsData[roomId].blocks.forEach(block => { if (block.driveId) deleteFromDrive(block.driveId); });
            delete roomsData[roomId];
        }
        io.to(roomId).emit('room-destroyed');
        io.in(roomId).socketsLeave(roomId);
    });

    socket.on('disconnecting', () => {
        for (const room of socket.rooms) {
            if (room !== socket.id && roomsData[room]) setTimeout(() => updateRoomStatus(room), 100);
        }
    });
});

const PORT = 3000;
const serverInstance = http.listen(PORT, () => console.log(`🚀 SwiftPaste 5TB Pro Ready trên port ${PORT}`));
serverInstance.timeout = 600000;