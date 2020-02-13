import * as path from "path";
import * as fs from "fs";
import { LuaDebugRuntime } from './luaDebugRuntime';
import { Socket } from 'net';
import { DebugLogger } from '../common/logManager';
import { LuaDebugSession } from './luaDebug';

function deleteFolder(folder:string) {
	if(fs.existsSync(folder)) {
		fs.readdirSync(folder).forEach(function(file, index) {
			let curPath = folder + "/" + file;
			if(fs.statSync(curPath).isDirectory()) { deleteFolder(curPath); }
			else {fs.unlinkSync(curPath)};
		});
		fs.rmdirSync(folder);
	}
}

export class FileReceiver {
    private total: number = 0;
    private totalData: Buffer = Buffer.alloc(0);
    private emptyData: Buffer = Buffer.alloc(0);
    private outDir: string = "";

    constructor(cwd: string) {
        this.outDir = path.join(cwd, "temp");
        deleteFolder(this.outDir);
    }

    private getBufferSize(data: Buffer, byteSize: number) {
        let size = 0;
        for (let i = 0; i < byteSize; i++) {
            // tslint:disable-next-line:no-bitwise
            size += (data[i] << ((byteSize - i - 1) * 8))
        }
        return size;
    }

    private getBuffer(data: Buffer, byteSize: number, byteOffset: number = 0) {
        return data.slice(byteSize + byteOffset, byteSize + byteOffset + this.getBufferSize(data, byteSize));
    }

    private unpackPackage(data: Buffer) {
        let fileName = this.getBuffer(data, 2).toString();
        if (fileName === "__sendFileEnd") {
            return true;
        }
        let context = this.getBuffer(data, 4, 2 + fileName.length).toString();
        let filePath = path.join(this.outDir, fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, context);
        DebugLogger.AdapterInfo("downLoad: " + fileName);
        return false;
    }

    private recvPackage(data: Buffer) {
        if (data.length < 4) {
            return null;
        }
        if (this.total === 0) {
            this.total = this.getBufferSize(data, 4);
        }
        if (data.length < 4 + this.total) {
            this.totalData = data;
            return null;
        }
        this.totalData = data.slice(4 + this.total);
        data = data.slice(4, 4 + this.total);
        this.total = 0;
        return data;
    }

    public getLeftData() {
        return this.total === 0 ? this.totalData : this.emptyData;
    }

    public processPackage(data: Buffer, concat: boolean = true) {
        let finished = false;
        let result = this.recvPackage(concat ? Buffer.concat([this.totalData, data]): data);
        if (result) {
            if (this.unpackPackage(result)) {
                finished = true;
            }
            if (this.processPackage(this.totalData, false)) {
                finished = true;
            }
        }
        if (finished) {
            this.total = 0;
        }
        return finished;
    }
}

//网络收发消息，记录回调
export class DataProcessor {

    public static _syncFiles: boolean = false;
    public static _fileReciver: FileReceiver;
    public static _runtime: LuaDebugRuntime;							//RunTime句柄
    public static _socket: Socket;
    private static orderList: Array<Object> = new Array();			//记录随机数和它对应的回调
    private static recvMsgQueue: Array<string> = new Array();   //记录粘包的多条指令
    private static cutoffString: string = "";
    private static getDataJsonCatch: string = "";                      //解析缓存，防止用户信息中含有分隔符
    /**
     * 接收从Debugger发来的消息
     * @param orgData: 消息串
     */
    public static processMsg(orgData: string) {
        let data = orgData.trim();
        if (this.cutoffString.length > 0) {
            data = this.cutoffString + data;
            this.cutoffString = "";
        }

        let pos = data.indexOf(DataProcessor._runtime.TCPSplitChar);
        if (pos < 0) {
            //没有分隔符，做截断判断
            DataProcessor.processCutoffMsg(data);
        } else {
            do {
                let data_save = data.substring(0, pos); //保存的命令
                data = data.substring(pos + DataProcessor._runtime.TCPSplitChar.length, data.length);
                DataProcessor.recvMsgQueue.push(data_save);
                pos = data.indexOf(DataProcessor._runtime.TCPSplitChar);
                if (pos < 0) {
                    //没有分隔符时，剩下的字符串不为空
                    DataProcessor.processCutoffMsg(data);
                }
            } while (pos > 0);

            while (DataProcessor.recvMsgQueue.length > 0) {
                let dt1 = DataProcessor.recvMsgQueue.shift();   //从头部取元素，保证是一个队列形式
                DataProcessor.getData(String(dt1));
            }
        }

        //最后处理一下超时回调
        for (let index = 0; index < DataProcessor.orderList.length; index++) {
            const element = DataProcessor.orderList[index];
            if ( element["timeOut"] && Date.now() > element["timeOut"] ){
                // dataProcessor._runtime.showError(element["callbackId"] + " 请求超时! 详细请求信息可在 Adapter/log 中搜索此id查看");
                let cb = element["callback"];
                cb(element["callbackArgs"]);
                DataProcessor.orderList.splice(index, 1);
            }
        }
    }

    /**
     * 切割消息
     * @param orgData: 消息串
     */
    private static processCutoffMsg(orgData: string) {
        let data = orgData.trim();
        if (data.length > 0) {
            DataProcessor.cutoffString = DataProcessor.cutoffString + data; //被截断的部分
        }
    }

    /**
     * 处理单条消息。主要包括解析json，分析命令，做相应处理
     * @param data 消息json
     */
    private static getData(data: string) {
        let cmdInfo;
        try{
            if(this.getDataJsonCatch != ""){
                data = this.getDataJsonCatch +  data;
            }
            cmdInfo = JSON.parse(data);
            if (LuaDebugSession.isNeedB64EncodeStr && cmdInfo.info !== undefined) {
                for (let i = 0, len = cmdInfo.info.length; i < len; i++) {
                    if (cmdInfo.info[i].type === "string") {
                        cmdInfo.info[i].value = Buffer.from(cmdInfo.info[i].value, 'base64').toString()
                    }
                }
            }
            this.getDataJsonCatch  = "";
        }
        catch(e){
            if(LuaDebugSession.isNeedB64EncodeStr){
                DataProcessor._runtime.showError(" JSON  解析失败! " + data);
                DebugLogger.AdapterInfo("[Adapter Error]: JSON  解析失败! " + data);
            }else{
                this.getDataJsonCatch = data + "|*|";
            }
            return;
        }

        if (DataProcessor._runtime != null) {
            if (cmdInfo == null) {
                DataProcessor._runtime.showError("JSON 解析失败! no cmdInfo:" + data);
                DebugLogger.AdapterInfo("[Adapter Error]:JSON解析失败  no cmdInfo:"+ data);
                return;
            }
            if (cmdInfo["cmd"] == undefined) {
                DataProcessor._runtime.showError("JSON 解析失败! no cmd:" + data);
                DebugLogger.AdapterInfo("[Adapter Warning]:JSON 解析失败 no cmd:"+ data);
            }

            if (cmdInfo["callbackId"] != undefined && cmdInfo["callbackId"] != "0") {
                //进入回调（如增加断点）
                for (let index = 0; index < DataProcessor.orderList.length; index++) {
                    const element = DataProcessor.orderList[index];
                    if (element["callbackId"] == cmdInfo["callbackId"]) {
                        let cb = element["callback"];
                        if (cmdInfo["info"] != null) {
                            cb(element["callbackArgs"], cmdInfo["info"]);
                        } else {
                            cb(element["callbackArgs"]);
                        }
                        DataProcessor.orderList.splice(index, 1);
                        return;
                    }
                }
                DebugLogger.AdapterInfo("[Adapter Error]: 没有在列表中找到回调");
            } else {
                if (cmdInfo["cmd"] == "refreshLuaMemory") {
                    DataProcessor._runtime.refreshLuaMemoty(cmdInfo["info"]["memInfo"]);
                    return;
                }

                if (cmdInfo["cmd"] == "tip") {
                    DataProcessor._runtime.showTip(cmdInfo["info"]["logInfo"]);
                    return;
                }

                if (cmdInfo["cmd"] == "tipError") {
                    DataProcessor._runtime.showError(cmdInfo["info"]["logInfo"]);
                    return;
                }

                if (cmdInfo["cmd"] == "stopOnBreakpoint" || cmdInfo["cmd"] == "stopOnEntry" || cmdInfo["cmd"] == "stopOnStep" || cmdInfo["cmd"] == "stopOnStepIn" || cmdInfo["cmd"] == "stopOnStepOut") {
                    // 进入断点/step停止
                    let stackInfo = cmdInfo["stack"];
                    DataProcessor._runtime.stop(stackInfo, cmdInfo["cmd"]);
                } else if (cmdInfo["cmd"] == "log") {
                    let logStr = cmdInfo["info"]["logInfo"];
                    if (logStr != null) {
                        DataProcessor._runtime.printLog(logStr);
                    }
                }
            }
        }
    }

    /**
     *	向 Debugger 发消息
     * @param cmd: 发给Debugger的命令 'contunue'/'stepover'/'stepin'/'stepout'/'restart'/'stop'
     * @param sendObject: 消息参数，会被放置在协议的info中
     * @param callbackFunc: 回调函数
     * @param callbackArgs: 回调参数
     */
    public static commandToDebugger(cmd: string, sendObject: Object, callbackFunc = null, callbackArgs = null, timeOutSec = 0) {
        //生成随机数
        let max = 999999999;
        let min = 10;		//10以内是保留位
        let isSame = false;
        let ranNum = 0;
        let sendObj = new Object();

        //有回调时才计算随机数
        if (callbackFunc != null) {
            do {
                isSame = false;
                ranNum = Math.floor(Math.random() * (max - min + 1) + min);
                //检查随机数唯一性
                DataProcessor.orderList.forEach(element => {
                    if (element["callbackId"] == ranNum) {
                        //若遍历后isSame依然是false，说明没有重合
                        isSame = true;
                    }
                });
            } while (isSame)

            let dic = new Object();
            dic["callbackId"] = ranNum;
            dic["callback"] = callbackFunc;
            if( timeOutSec > 0){
                dic["timeOut"] = Date.now() + timeOutSec * 1000; 
            }

            if (callbackArgs != null) {
                dic["callbackArgs"] = callbackArgs;
            }
            DataProcessor.orderList.push(dic);
            sendObj["callbackId"] = ranNum.toString();
        }

        sendObj["cmd"] = cmd;
        sendObj["info"] = sendObject;
        const str = JSON.stringify(sendObj) + " " + DataProcessor._runtime.TCPSplitChar + "\n";
        //记录随机数和回调的对应关系
        if (DataProcessor._socket != undefined) {
            DebugLogger.AdapterInfo("[Send Msg]:" + str);
            DataProcessor._socket.write(str);
        } else {
            DebugLogger.AdapterInfo("[Send Msg but socket deleted]:" + str);
        }
    }
}
