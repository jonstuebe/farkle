import React from 'react';

const BottomDrawer = React.createClass({
	render() {
		return (
			<footer className="bottom-drawer">
				{this.props.children}
			</footer>
		)
	}
});

export default BottomDrawer;
