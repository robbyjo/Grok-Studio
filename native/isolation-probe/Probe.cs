// Disposable capability probe only. This does not sandbox Workbench's agent.
// Win32 declarations follow Microsoft's AppContainer launch documentation.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
class Probe {
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttrs,IntPtr threadAttrs,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
  [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr Sid, Capabilities; public uint Count,Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public StartupInfo Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  static bool Attempt(Action action) { try { action(); return true; } catch { return false; } }
  static string Bool(bool value) { return value ? "true" : "false"; }
  static void Child(string[] args) {
    string allowed=args[1], denied=args[2]; int port=int.Parse(args[3]);
    bool allowedRead=Attempt(()=> { if(File.ReadAllText(Path.Combine(allowed,"input.txt"))!="ALLOW_CANARY") throw new Exception(); });
    bool allowedWrite=Attempt(()=>File.WriteAllText(Path.Combine(allowed,"output.txt"),"ALLOW_WRITE"));
    bool outsideRead=Attempt(()=>File.ReadAllText(Path.Combine(denied,"private.txt")));
    bool outsideWrite=Attempt(()=>File.WriteAllText(Path.Combine(denied,"unauthorized.txt"),"BAD"));
    bool network=false;
    using(var client=new TcpClient()) { try { var pending=client.BeginConnect("127.0.0.1",port,null,null); if(pending.AsyncWaitHandle.WaitOne(1500)) { client.EndConnect(pending); network=true; } } catch {} }
    string json="{\"allowedRead\":"+Bool(allowedRead)+",\"allowedWrite\":"+Bool(allowedWrite)+",\"privateReadDenied\":"+Bool(!outsideRead)+",\"privateWriteDenied\":"+Bool(!outsideWrite)+",\"loopbackDenied\":"+Bool(!network)+"}";
    File.WriteAllText(Path.Combine(allowed,"child-result.json"),json);
  }
  static void Grant(string path,SecurityIdentifier sid,FileSystemRights rights) {
    var acl=Directory.GetAccessControl(path); acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); Directory.SetAccessControl(path,acl);
  }
  static int Main(string[] args) {
    if(args.Length>0 && args[0]=="child") { Child(args); return 0; }
    if(args.Length!=1) throw new Exception("Expected isolated probe folder.");
    string root=Path.GetFullPath(args[0]), name="GrokWorkbenchProbe."+Guid.NewGuid().ToString("N"), allowed=Path.Combine(root,"allowed"), denied=Path.Combine(root,"private");
    IntPtr sid=IntPtr.Zero,list=IntPtr.Zero,caps=IntPtr.Zero; TcpListener listener=null; bool created=false;
    try {
      Directory.CreateDirectory(allowed); Directory.CreateDirectory(denied); File.WriteAllText(Path.Combine(allowed,"input.txt"),"ALLOW_CANARY"); File.WriteAllText(Path.Combine(denied,"private.txt"),"PRIVATE_CANARY");
      var privateAcl=new DirectorySecurity(); privateAcl.SetAccessRuleProtection(true,false); privateAcl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow)); Directory.SetAccessControl(denied,privateAcl);
      int result=CreateAppContainerProfile(name,name,"Disposable Workbench isolation probe",IntPtr.Zero,0,out sid); if(result!=0) Marshal.ThrowExceptionForHR(result); created=true;
      var identity=new SecurityIdentifier(sid); Grant(allowed,identity,FileSystemRights.FullControl);
      var executable=Process.GetCurrentProcess().MainModule.FileName;
      var binaryAcl=File.GetAccessControl(executable); binaryAcl.AddAccessRule(new FileSystemAccessRule(identity,FileSystemRights.ReadAndExecute,AccessControlType.Allow)); File.SetAccessControl(executable,binaryAcl);
      listener=new TcpListener(IPAddress.Loopback,0); listener.Start(); int port=((IPEndPoint)listener.LocalEndpoint).Port;
      // Confirm this listener is reachable from the normal host token.
      using(var control=new TcpClient()) { control.Connect("127.0.0.1",port); }
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); list=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(list,1,0,ref size)) throw new System.ComponentModel.Win32Exception();
      var security=new SecurityCapabilities { Sid=sid }; caps=Marshal.AllocHGlobal(Marshal.SizeOf(security)); Marshal.StructureToPtr(security,caps,false);
      if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),caps,new IntPtr(Marshal.SizeOf(security)),IntPtr.Zero,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      var start=new StartupEx { Attributes=list }; start.Info.cb=(uint)Marshal.SizeOf(start); ProcessInfo child;
      var command=new StringBuilder("\""+executable+"\" child \""+allowed+"\" \""+denied+"\" "+port);
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x80000|0x08000000,IntPtr.Zero,allowed,ref start,out child)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      CloseHandle(child.Thread);
      try {
        if(WaitForSingleObject(child.Process,20000)!=0) { TerminateProcess(child.Process,1); WaitForSingleObject(child.Process,5000); throw new Exception("Owned probe timed out."); }
        uint exitCode; if(!GetExitCodeProcess(child.Process,out exitCode) || exitCode!=0) throw new Exception("AppContainer child failed: "+exitCode);
      } finally { CloseHandle(child.Process); }
      string evidence=File.ReadAllText(Path.Combine(allowed,"child-result.json")); Console.WriteLine(evidence); File.WriteAllText(Path.Combine(root,"result.json"),evidence);
      if(File.ReadAllText(Path.Combine(denied,"private.txt"))!="PRIVATE_CANARY" || File.Exists(Path.Combine(denied,"unauthorized.txt"))) throw new Exception("Private canary changed.");
      return 0;
    } finally {
      if(listener!=null) listener.Stop(); if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); } if(caps!=IntPtr.Zero) Marshal.FreeHGlobal(caps); if(sid!=IntPtr.Zero) FreeSid(sid);
      if(created) { int deleted=DeleteAppContainerProfile(name); if(deleted!=0) Marshal.ThrowExceptionForHR(deleted); Console.WriteLine("APP_CONTAINER_PROFILE_REMOVED"); }
    }
  }
}
