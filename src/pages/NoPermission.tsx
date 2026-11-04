export function NoPermissionPage({ notFound }: { notFound?: boolean }) {
  return (
    <div className="panel">
      <h1>{notFound ? '页面不存在' : '无权限'}</h1>
      <p>{notFound ? '请从菜单进入。' : '你的账号没有这个页面的权限。需要时请联系运维超管。'}</p>
    </div>
  );
}
